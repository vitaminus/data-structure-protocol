export function hashPassword(password: string): string {
  return `hashed:${password}`;
}
