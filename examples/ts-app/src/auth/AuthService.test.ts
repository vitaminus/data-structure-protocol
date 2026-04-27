import { describe, expect, it } from "vitest";
import { AuthService } from "./AuthService";

describe("AuthService", () => {
  it("creates user", () => {
    const service = new AuthService();
    const result = service.createUser("user@example.com", "secret");
    expect(result.passwordHash).toContain("hashed:");
  });
});
