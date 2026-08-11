import dotenv from "dotenv";
import path from "path";
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
import express from "express";
import cors from "cors";
import authRoutes from "./routes/auth";
import sceneRoutes from "./routes/scenes";
import fileRoutes from "./routes/files";
import libraryRoutes from "./routes/libraries";
import teamRoutes from "./routes/teams";
import collabRoutes from "./routes/collab";

const app = express();
const PORT = parseInt(process.env.PORT || "4001");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "50mb" }));

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/scenes", sceneRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/libraries", libraryRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/collab", collabRoutes);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Excalidraw API running on port ${PORT}`);
});

export default app;
