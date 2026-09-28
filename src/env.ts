// Imported first by index.ts so env vars are loaded before any module reads them
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
