// Zero npm dependencies — just Node's built-in fetch.
// Chrome runs on Browserless servers; this function only sends/receives JSON.

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers["content-type"] || "";
    const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) return reject(new Error("No boundary in multipart"));
    const boundary = "--" + boundaryMatch[1];

    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("latin1");
      const parts = body.split(boundary).slice(1, -1);
      const fields = {};
      let fileContent = null;

      for (const part of parts) {
        const [rawHeaders, ...bodyParts] = part.split("\r\n\r\n");
        const content = bodyParts.join("\r\n\r\n").replace(/\r\n$/, "");
        const nameMatch = rawHeaders.match(/name="([^"]+)"/);
        const fileMatch = rawHeaders.match(/filename="([^"]+)"/);
        if (!nameMatch) continue;
        if (fileMatch) {
          fileContent = content;
        } else {
          fields[nameMatch[1]] = content;
        }
      }
      resolve({ fields, fileContent });
    });
    req.on("error", reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const TOKEN = process.env.BROWSERLESS_TOKEN;
  if (!TOKEN) {
    return res.status(500).json({
      error: "BROWSERLESS_TOKEN is not set. Add it in your Vercel environment variables."
    });
  }

  let html = "", renderWidth = 1280, scale = 1;

  try {
    const ct = req.headers["content-type"] || "";

    if (ct.includes("multipart/form-data")) {
      const { fields, fileContent } = await parseMultipart(req);
      // fileContent was extracted from a latin1-decoded body to keep byte
      // boundaries intact; round-trip it back to proper UTF-8 text here,
      // otherwise multi-byte characters (smart quotes, em-dashes, bullets,
      // accented letters, emoji) come out as mojibake.
      html = fileContent
        ? Buffer.from(fileContent, "latin1").toString("utf8")
        : (fields.html || "");
      renderWidth = parseInt(fields.renderWidth || "1280", 10);
      scale = parseFloat(fields.scale || "1");
    } else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      html = body.html || "";
      renderWidth = parseInt(body.renderWidth || "1280", 10);
      scale = parseFloat(body.scale || "1");
    }

    if (!html.trim()) {
      return res.status(400).json({ error: "No HTML content provided." });
    }

    const puppeteerScript = `
      export default async function({ page }) {
        await page.emulateMediaType("screen");

        // Look like a real Chrome so hotlink-protected image hosts don't 403.
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        );
        await page.setExtraHTTPHeaders({
          "Accept-Language": "en-US,en;q=0.9",
        });

        await page.setViewport({ width: ${renderWidth}, height: 900, deviceScaleFactor: ${scale} });

        await page.setContent(${JSON.stringify(html)}, {
          waitUntil: ["networkidle0", "domcontentloaded"],
          timeout: 45000,
        });

        // Wait for all fonts to actually finish loading
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(async () => {
          await Promise.all([...document.fonts].map(f => f.load().catch(() => {})));
        });

        // Inject Noto Sans + Noto Color Emoji as fallback for every element.
        // This covers special characters and symbols missing from the primary font
        // without overriding it — the primary font still renders first.
        // Noto Sans covers text; Symbols / Symbols 2 cover dingbats, arrows,
        // checkmarks, stars, phone/mail glyphs and other "icon" characters;
        // Color Emoji covers emoji. Together they fill almost every glyph gap
        // left by fonts that aren't installed on the Linux renderer.
        await page.addStyleTag({
          url: "https://fonts.googleapis.com/css2?family=Noto+Sans:ital,wght@0,400;0,700;1,400;1,700&family=Noto+Sans+Symbols&family=Noto+Sans+Symbols+2&family=Noto+Color+Emoji&display=swap"
        });
        const FALLBACK = '"Noto Sans", "Noto Sans Symbols", "Noto Sans Symbols 2", "Noto Color Emoji"';
        // Force markers (bullets / list numbers) to fonts that definitely have
        // the glyphs — substituted fonts on the Linux renderer often lack them,
        // which is what turns bullets into little boxes (tofu).
        await page.addStyleTag({
          content: '::marker { font-family: ' + FALLBACK + ' !important; }'
        });
        await page.evaluate(async (FALLBACK) => {
          await Promise.all([
            'Noto Sans', 'Noto Sans Symbols', 'Noto Sans Symbols 2', 'Noto Color Emoji'
          ].map(f => document.fonts.load('400 16px "' + f + '"').catch(() => {})));
          document.querySelectorAll("*").forEach(el => {
            const ff = window.getComputedStyle(el).fontFamily;
            if (ff && !ff.includes("Noto")) {
              el.style.fontFamily = ff + ', ' + FALLBACK;
            }
          });
        }, FALLBACK);

        // Force-load lazy images and trigger full layout
        await page.evaluate(() => {
          document.querySelectorAll("img[loading='lazy']").forEach(img => {
            img.loading = "eager";
            if (img.dataset.src) img.src = img.dataset.src;
            if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
          });
          window.scrollTo(0, document.body.scrollHeight);
        });

        await new Promise(r => setTimeout(r, 1500));

        // Explicitly wait for every image to finish (or fail) so a slow header
        // image isn't missed by the networkidle heuristic.
        await page.evaluate(async () => {
          await Promise.all([...document.images].map(img => {
            if (img.complete && img.naturalWidth > 0) return Promise.resolve();
            return new Promise(res => {
              img.addEventListener("load", res, { once: true });
              img.addEventListener("error", res, { once: true });
              setTimeout(res, 12000);
            });
          }));
        });

        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 500));

        const dims = await page.evaluate(() => ({
          width: Math.max(
            document.body.scrollWidth, document.documentElement.scrollWidth,
            document.body.offsetWidth,  document.documentElement.clientWidth
          ),
          height: Math.max(
            document.body.scrollHeight, document.documentElement.scrollHeight,
            document.body.offsetHeight
          ),
        }));

        await page.setViewport({
          width: Math.max(dims.width, ${renderWidth}),
          height: dims.height,
          deviceScaleFactor: ${scale},
        });

        await new Promise(r => setTimeout(r, 300));

        const MM = 25.4 / 96;
        const pdfW = dims.width  * MM;
        const pdfH = dims.height * MM;

        const pdf = await page.pdf({
          width:           pdfW + "mm",
          height:          pdfH + "mm",
          printBackground: true,
          margin:          { top: 0, bottom: 0, left: 0, right: 0 },
          scale:           1,
        });

        const bytes = new Uint8Array(pdf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        const pdfBase64 = btoa(binary);

        return {
          pdf: pdfBase64,
          dims,
          pdfW,
          pdfH,
        };
      }
    `;

    // POST the script to Browserless /function — returns JSON with base64 PDF
    const blessRes = await fetch(
      `https://production-sfo.browserless.io/function?token=${TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/javascript" },
        body: puppeteerScript,
      }
    );

    if (!blessRes.ok) {
      const errText = await blessRes.text();
      throw new Error(`Browserless error ${blessRes.status}: ${errText}`);
    }

    const result = await blessRes.json();

    const pdfBuffer = Buffer.from(result.pdf, "base64");
    const { dims, pdfW, pdfH } = result;

    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
    res.setHeader("Content-Length",      pdfBuffer.length);
    res.setHeader("X-Content-Width-PX",  String(dims?.width  || ""));
    res.setHeader("X-Content-Height-PX", String(dims?.height || ""));
    res.setHeader("X-PDF-Width-MM",      pdfW ? pdfW.toFixed(2) : "");
    res.setHeader("X-PDF-Height-MM",     pdfH ? pdfH.toFixed(2) : "");

    return res.status(200).end(pdfBuffer);

  } catch (err) {
    console.error("Conversion error:", err);
    return res.status(500).json({ error: err.message || "Conversion failed." });
  }
};
