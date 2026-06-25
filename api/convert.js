const chromium = require("@sparticuz/chromium");
const puppeteer = require("puppeteer-core");
const busboy = require("busboy");

// Sparticuz chromium is tuned for AWS Lambda / Vercel serverless
chromium.setHeadlessMode = true;
chromium.setGraphicsMode = false;

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let fileBuffer = null;

    const bb = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });

    bb.on("field", (name, val) => { fields[name] = val; });

    bb.on("file", (_name, stream, _info) => {
      const chunks = [];
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("end", () => { fileBuffer = Buffer.concat(chunks); });
    });

    bb.on("close", () => resolve({ fields, fileBuffer }));
    bb.on("error", reject);

    req.pipe(bb);
  });
}

module.exports = async function handler(req, res) {
  // CORS headers so the frontend can call this from any origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let html = "";
  let renderWidth = 1280;
  let scale = 1;

  try {
    const contentType = req.headers["content-type"] || "";

    if (contentType.includes("multipart/form-data")) {
      const { fields, fileBuffer } = await parseMultipart(req);
      html = fileBuffer ? fileBuffer.toString("utf-8") : (fields.html || "");
      renderWidth = parseInt(fields.renderWidth || "1280", 10);
      scale = parseFloat(fields.scale || "1");
    } else if (contentType.includes("application/json")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      html = body.html || "";
      renderWidth = parseInt(body.renderWidth || "1280", 10);
      scale = parseFloat(body.scale || "1");
    } else {
      // Try JSON fallback
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        html = body.html || "";
        renderWidth = parseInt(body.renderWidth || "1280", 10);
        scale = parseFloat(body.scale || "1");
      } catch (_) {
        return res.status(400).json({ error: "Could not parse request body." });
      }
    }

    if (!html || html.trim() === "") {
      return res.status(400).json({ error: "No HTML content provided." });
    }

    // Launch headless Chrome via sparticuz/chromium
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Set viewport to target render width
    await page.setViewport({
      width: renderWidth,
      height: 900,
      deviceScaleFactor: scale,
    });

    // Load HTML — setContent handles inline resources;
    // networkidle0 waits for all external images/fonts to finish loading
    await page.setContent(html, {
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 45000,
    });

    // Give web fonts and lazy images a moment to settle
    await new Promise(r => setTimeout(r, 1000));

    // Trigger lazy-loaded images and scroll to bottom to force-load them
    await page.evaluate(() => {
      document.querySelectorAll("img[loading='lazy']").forEach(img => {
        img.loading = "eager";
        if (img.dataset.src) img.src = img.dataset.src;
        if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
      });
      // Scroll to trigger any scroll-based lazy loaders
      window.scrollTo(0, document.body.scrollHeight);
    });

    await new Promise(r => setTimeout(r, 600));
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 300));

    // Measure full rendered content size
    const dims = await page.evaluate(() => ({
      width: Math.max(
        document.body.scrollWidth,
        document.documentElement.scrollWidth,
        document.body.offsetWidth,
        document.documentElement.clientWidth
      ),
      height: Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        document.body.offsetHeight
      ),
    }));

    // Resize viewport to full content dimensions so nothing is clipped
    await page.setViewport({
      width: Math.max(dims.width, renderWidth),
      height: dims.height,
      deviceScaleFactor: scale,
    });

    await new Promise(r => setTimeout(r, 300));

    // Convert px → mm at 96dpi standard
    const MM_PER_PX = 25.4 / 96;
    const pdfWidthMM = dims.width * MM_PER_PX;
    const pdfHeightMM = dims.height * MM_PER_PX;

    // Generate PDF — single page sized exactly to content
    const pdfBuffer = await page.pdf({
      width: `${pdfWidthMM}mm`,
      height: `${pdfHeightMM}mm`,
      printBackground: true,
      margin: { top: 0, bottom: 0, left: 0, right: 0 },
      scale: 1,
    });

    await browser.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="converted.pdf"');
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("X-Content-Width-PX", String(dims.width));
    res.setHeader("X-Content-Height-PX", String(dims.height));
    res.setHeader("X-PDF-Width-MM", pdfWidthMM.toFixed(2));
    res.setHeader("X-PDF-Height-MM", pdfHeightMM.toFixed(2));

    return res.status(200).end(pdfBuffer);

  } catch (err) {
    console.error("Conversion error:", err);
    return res.status(500).json({
      error: err.message || "Conversion failed. Check your HTML and try again.",
    });
  }
};
