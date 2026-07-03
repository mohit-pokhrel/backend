/**
 * Backend server for the Live Facial Expression Recognition app.
 *
 * Videos are uploaded to Cloudinary for persistent storage.
 *
 * Required environment variables on Render:
 *   CLOUDINARY_CLOUD_NAME  — your Cloudinary cloud name
 *   CLOUDINARY_API_KEY     — your Cloudinary API key
 *   CLOUDINARY_API_SECRET  — your Cloudinary API secret
 *
 * Run with: npm install && npm start
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// Cloudinary setup
// ---------------------------------------------------------------------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

function uploadToCloudinary(buffer, filename, emotion) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "video",
        public_id: filename,
        folder: "expression-scans",
        context: `emotion=${emotion || "unknown"}`,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const allowedOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Multer: memory storage — goes straight to Cloudinary, no disk needed
// ---------------------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith("video/")) {
      cb(null, true);
    } else {
      cb(new Error("Only video files are allowed"));
    }
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    cloudinaryConfigured: !!(
      process.env.CLOUDINARY_CLOUD_NAME &&
      process.env.CLOUDINARY_API_KEY &&
      process.env.CLOUDINARY_API_SECRET
    ),
  });
});

/**
 * POST /api/upload
 * multipart/form-data:
 *   - video      (file)   — the recorded webm/mp4
 *   - emotion    (string) — detected dominant emotion
 *   - confidence (number) — confidence score 0–1
 */
app.post("/api/upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No video file received" });
  }

  const { emotion, confidence } = req.body;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const uniqueId = crypto.randomBytes(4).toString("hex");
  const filename = `recording_${timestamp}_${emotion || "unknown"}_${uniqueId}`;

  try {
    const result = await uploadToCloudinary(req.file.buffer, filename, emotion);

    console.log(`✅ Uploaded to Cloudinary: ${result.public_id} | emotion=${emotion || "n/a"} | url=${result.secure_url}`);

    res.json({
      success: true,
      filename: result.public_id,
      url: result.secure_url,
      emotion: emotion || null,
      confidence: confidence || null,
    });
  } catch (err) {
    console.error("Cloudinary upload error:", err.message);
    res.status(500).json({ success: false, error: "Failed to upload to Cloudinary: " + err.message });
  }
});

// Multer / generic error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`🚀 Expression recognition backend running on http://localhost:${PORT}`);
  console.log(`☁️  Storage: Cloudinary (cloud: ${process.env.CLOUDINARY_CLOUD_NAME || "not configured"})`);
});
