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
      html = fileContent || fields.html || "";
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

    // Escape HTML for embedding in a JS string inside JSON
    const escapedHtml = html
      .replace(/\\/g, "\\\\")
      .replace(/`/g, "\\`")
      .replace(/\$/g, "\\$");

    // This script runs inside Browserless's Chrome instance.
    // It measures full content size, resizes the viewport, then exports a single-page PDF.
    const puppeteerScript = `
      export default async function({ page }) {
        await page.setViewport({ width: ${renderWidth}, height: 900, deviceScaleFactor: ${scale} });

        await page.setContent(\`${escapedHtml}\`, {
          waitUntil: ["networkidle0", "domcontentloaded"],
          timeout: 45000,
        });

        await new Promise(r => setTimeout(r, 1000));

        // Force-load lazy images
        await page.evaluate(() => {
          document.querySelectorAll("img[loading='lazy']").forEach(img => {
            img.loading = "eager";
            if (img.dataset.src) img.src = img.dataset.src;
            if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
          });
          window.scrollTo(0, document.body.scrollHeight);
        });

        await new Promise(r => setTimeout(r, 600));
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 300));

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

        return {
          pdf: Buffer.from(pdf).toString("base64"),
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
