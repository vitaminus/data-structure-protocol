import { hashPassword } from "./crypto";

export class AuthService {
  createUser(email: string, password: string): { email: string; passwordHash: string } {
    return {
      email,
      passwordHash: hashPassword(password)
    };
  }
}
