import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { env } from "./config";
import prisma from "./lib/prisma";
import { ensureAdminUser } from "./lib/seed";
import { ensureUploadsDir } from "./lib/storage";
import { registerAuthRoutes } from "./routes/auth";
import { registerUserRoutes } from "./routes/users";
import { registerAuditRoutes } from "./routes/audit";
import { registerDashboardRoutes } from "./routes/dashboard";
import { registerMeiRoutes } from "./routes/modules/mei";
import { registerVendorDirectoryRoutes } from "./routes/vendorDirectory";
import type { AuthUser } from "./types";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

const app = Fastify({ logger: false });

async function bootstrap(): Promise<void> {
  ensureUploadsDir();

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 25 * 1024 * 1024
    }
  });

  app.get("/api/health", async () => ({ status: "ok" }));

  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerAuditRoutes(app);
  await registerDashboardRoutes(app);
  await registerVendorDirectoryRoutes(app);
  await registerMeiRoutes(app);

  await app.register(fastifyStatic, {
    root: env.uploadsDir,
    prefix: "/uploads/",
    decorateReply: false
  });

  const frontendDist = path.resolve(__dirname, "..", "..", "frontend", "dist");
  if (fs.existsSync(frontendDist)) {
    await app.register(fastifyStatic, {
      root: frontendDist,
      wildcard: false
    });

    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ message: "Rota nao encontrada." });
      }

      return reply.sendFile("index.html");
    });
  }

  await prisma.$connect();
  await ensureAdminUser();

  await app.listen({
    port: env.port,
    host: "0.0.0.0"
  });
}

bootstrap().catch(async (error) => {
  console.error("Falha ao iniciar o backend:", error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
