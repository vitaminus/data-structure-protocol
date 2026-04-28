import { hashToken } from "./crypto";

export class AuthService {
  validateToken(token: string): boolean {
    return hashToken(token).startsWith("hashed:");
  }
}
