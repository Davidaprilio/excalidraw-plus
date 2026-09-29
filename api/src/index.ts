import "./env";
import express from "express";
import cors from "cors";
import { runMigrations } from "./db/migrate";
import authRoutes from "./routes/auth";
import sceneRoutes from "./routes/scenes";
import fileRoutes from "./routes/files";
import libraryRoutes from "./routes/libraries";
import teamRoutes from "./routes/teams";
import collabRoutes from "./routes/collab";
import workspaceRoutes from "./routes/workspaces";
import inviteRoutes from "./routes/invites";
import avatarRoutes from "./routes/avatars";
import commentRoutes from "./routes/comments";
import securityRoutes from "./routes/security";

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
app.use("/api/auth", securityRoutes);
app.use("/api/scenes/:sceneId/comments", commentRoutes);
app.use("/api/scenes", sceneRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/libraries", libraryRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/collab", collabRoutes);
// public avatars first: the workspaces router requires auth for everything
app.use("/api", avatarRoutes);
app.use("/api/workspaces", workspaceRoutes);
app.use("/api/invites", inviteRoutes);

runMigrations()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Excalidraw API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

export default app;
