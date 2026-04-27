export class AuthService {
  login(email: string, password: string): boolean {
    return email.length > 0 && password.length > 0;
  }
}
