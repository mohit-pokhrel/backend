/**
 * Backend server for the Live Facial Expression Recognition app.
 *
 * Videos are uploaded to Google Drive for persistent storage instead of
 * local disk (which is ephemeral on Render's free tier).
 *
 * Required environment variables on Render:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — the full contents of your service account JSON key file
 *   GOOGLE_DRIVE_FOLDER_ID       — the Drive folder ID to upload videos into
 *
 * Run with: npm install && npm start
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const crypto = require("crypto");
const { Readable } = require("stream");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 4000;

// ---------------------------------------------------------------------------
// Google Drive setup
// ---------------------------------------------------------------------------
let driveClient = null;
const FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

function getDriveClient() {
  if (driveClient) return driveClient;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var not set");
  if (!FOLDER_ID) throw new Error("GOOGLE_DRIVE_FOLDER_ID env var not set");

  const credentials = JSON.parse(raw);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });

  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

async function uploadToDrive(buffer, filename, mimeType, emotion, confidence) {
  const drive = getDriveClient();
  const stream = Readable.from(buffer);

  // Step 1: upload the file without a parent (lands in service account space)
  const createResponse = await drive.files.create({
    requestBody: {
      name: filename,
      properties: {
        emotion: emotion || "unknown",
        confidence: confidence ? String(Math.round(Number(confidence) * 100)) + "%" : "n/a",
      },
      description: `Expression scan — detected: ${emotion || "unknown"} (${
        confidence ? Math.round(Number(confidence) * 100) + "%" : "n/a"
      })`,
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: "id,name",
  });

  const fileId = createResponse.data.id;

  // Step 2: move it into your shared Drive folder
  const moveResponse = await drive.files.update({
    fileId,
    addParents: FOLDER_ID,
    removeParents: "root",
    supportsAllDrives: true,
    fields: "id,name,webViewLink",
  });

  return moveResponse.data;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
const allowedOrigin = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: allowedOrigin }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Multer: store upload in memory (no disk needed — goes straight to Drive)
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
    driveConfigured: !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && FOLDER_ID),
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
  const uniqueId = crypto.randomBytes(6).toString("hex");
  const ext = req.file.mimetype.includes("mp4") ? ".mp4" : ".webm";
  const filename = `recording_${timestamp}_${emotion || "unknown"}_${uniqueId}${ext}`;

  try {
    const driveFile = await uploadToDrive(
      req.file.buffer,
      filename,
      req.file.mimetype,
      emotion,
      confidence
    );

    console.log(`✅ Uploaded to Drive: ${driveFile.name} | emotion=${emotion || "n/a"} | id=${driveFile.id}`);

    res.json({
      success: true,
      filename: driveFile.name,
      driveId: driveFile.id,
      driveLink: driveFile.webViewLink,
      emotion: emotion || null,
    });
  } catch (err) {
    console.error("Drive upload error:", err.message);
    res.status(500).json({ success: false, error: "Failed to upload to Google Drive: " + err.message });
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
  console.log(`📁 Storage: Google Drive folder ${FOLDER_ID || "(not configured)"}`);
});
