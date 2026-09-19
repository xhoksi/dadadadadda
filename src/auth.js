import crypto from "node:crypto";
import { getStore } from "./store.js";

const sessions = new Map();
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

export function createSession(userId) {
  const token = crypto.randomBytes(24).toString("base64url");
  sessions.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
}

export function userFromToken(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return getStore().users[session.userId] || null;
}

export function loginByHandle(handle) {
  const store = getStore();
  const user = Object.values(store.users).find((u) => u.handle === handle.toLowerCase());
  if (!user) return null;
  return { user, token: createSession(user.id) };
}

const ROLE_LABELS = {
  platform_admin: "Platform administrator",
  moderator: "Moderator / support",
  owner: "Profile owner",
  visitor: "Visitor",
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

export function isAdmin(user) {
  return !!user && user.role === "platform_admin";
}

export function isModerator(user) {
  return !!user && user.role === "moderator";
}

export function isOwnerOrAdmin(user, page) {
  return !!user && (isAdmin(user) || page.ownerId === user.id);
}

export function publicUser(user) {
  return {
    id: user.id,
    handle: user.handle,
    role: user.role,
    roleLabel: roleLabel(user.role),
    plan: user.plan,
  };
}

export function authMiddleware(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  req.user = token ? userFromToken(token) : null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ message: "Authentication required." });
    return;
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ message: "Authentication required." });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ message: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}