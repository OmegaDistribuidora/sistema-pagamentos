import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config";
import type { AppUserRole, AuthUser } from "../types";

type JwtPayload = {
  userId: number;
  username: string;
  role: AppUserRole;
};

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "8h" });
}

export function verifyToken(token: string): AuthUser {
  return jwt.verify(token, env.jwtSecret) as AuthUser;
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = request.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) {
    reply.code(401).send({ message: "Token ausente." });
    return;
  }

  try {
    request.authUser = verifyToken(token);
  } catch (error) {
    reply.code(401).send({ message: "Token invalido." });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.authUser) {
    reply.code(401).send({ message: "Usuario nao autenticado." });
    return;
  }

  if (request.authUser.role !== "ADMIN") {
    reply.code(403).send({ message: "Acesso restrito ao administrador." });
  }
}

export async function requireSupervisor(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.authUser) {
    reply.code(401).send({ message: "Usuario nao autenticado." });
    return;
  }

  if (request.authUser.role !== "USER") {
    reply.code(403).send({ message: "Acesso restrito ao supervisor." });
  }
}
