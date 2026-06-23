// server.js — Backend Glitch pour QR Dictaphone
// Variables d'environnement à configurer dans Glitch (.env) :
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_SERVICE_KEY=eyJ...   (clé "service_role", pas "anon")
//   ADMIN_PASSWORD=votre_mot_de_passe_admin

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const crypto = require("crypto");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
});

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const BUCKET = "audio-slots"; // à créer dans Supabase Storage

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static("public")); // sert index.html, admin.html, etc.

// ── Auth admin simple ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.headers["x-admin-password"];
  if (!pwd || pwd !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Non autorisé" });
  }
  next();
}

// ── API : état d'un slot ───────────────────────────────────────────────────────
// GET /api/slot/:id  → { state: "empty"|"recorded", label, audioUrl? }
app.get("/api/slot/:id", async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from("slots")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "Slot introuvable" });
  }

  let audioUrl = null;
  if (data.audio_path) {
    const { data: urlData } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(data.audio_path, 3600); // URL valide 1h
    audioUrl = urlData?.signedUrl ?? null;
  }

  res.json({
    state: data.audio_path ? "recorded" : "empty",
    label: data.label,
    audioUrl,
  });
});

// ── API : enregistrer l'audio d'un slot ───────────────────────────────────────
// POST /api/slot/:id/record  (multipart, champ "audio")
app.post("/api/slot/:id/record", upload.single("audio"), async (req, res) => {
  const { id } = req.params;

  // Vérifier que le slot existe et est encore vide
  const { data: slot, error: slotErr } = await supabase
    .from("slots")
    .select("*")
    .eq("id", id)
    .single();

  if (slotErr || !slot) {
    return res.status(404).json({ error: "Slot introuvable" });
  }
  if (slot.audio_path) {
    return res.status(409).json({ error: "Déjà enregistré" });
  }
  if (!req.file) {
    return res.status(400).json({ error: "Fichier audio manquant" });
  }

  // Upload dans Supabase Storage
  const ext = req.file.mimetype.includes("ogg") ? "ogg" : "webm";
  const audioPath = `${id}/message.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(audioPath, req.file.buffer, {
      contentType: req.file.mimetype,
      upsert: false,
    });

  if (uploadErr) {
    console.error("Upload error:", uploadErr);
    return res.status(500).json({ error: "Erreur upload audio" });
  }

  // Mettre à jour la DB
  const { error: updateErr } = await supabase
    .from("slots")
    .update({ audio_path: audioPath, recorded_at: new Date().toISOString() })
    .eq("id", id);

  if (updateErr) {
    console.error("DB update error:", updateErr);
    return res.status(500).json({ error: "Erreur mise à jour DB" });
  }

  res.json({ success: true });
});

// ── API admin : lister tous les slots ─────────────────────────────────────────
// GET /api/admin/slots
app.get("/api/admin/slots", requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from("slots")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── API admin : créer un slot ──────────────────────────────────────────────────
// POST /api/admin/slots  { label: "Table 4" }
app.post("/api/admin/slots", requireAdmin, async (req, res) => {
  const { label } = req.body;
  if (!label) return res.status(400).json({ error: "Label requis" });

  const id = crypto.randomBytes(6).toString("hex"); // ex: "a3f9c2"

  const { data, error } = await supabase
    .from("slots")
    .insert({ id, label, audio_path: null })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── API admin : réinitialiser un slot (effacer l'audio) ───────────────────────
// DELETE /api/admin/slots/:id/audio
app.delete("/api/admin/slots/:id/audio", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const { data: slot } = await supabase
    .from("slots")
    .select("audio_path")
    .eq("id", id)
    .single();

  if (slot?.audio_path) {
    await supabase.storage.from(BUCKET).remove([slot.audio_path]);
  }

  await supabase
    .from("slots")
    .update({ audio_path: null, recorded_at: null })
    .eq("id", id);

  res.json({ success: true });
});

// ── API admin : supprimer un slot entier ──────────────────────────────────────
// DELETE /api/admin/slots/:id
app.delete("/api/admin/slots/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  const { data: slot } = await supabase
    .from("slots")
    .select("audio_path")
    .eq("id", id)
    .single();

  if (slot?.audio_path) {
    await supabase.storage.from(BUCKET).remove([slot.audio_path]);
  }

  await supabase.from("slots").delete().eq("id", id);
  res.json({ success: true });
});

// ── Démarrage ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎙️  QR Dictaphone running on port ${PORT}`));
