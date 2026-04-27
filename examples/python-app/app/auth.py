from crypto import hash_password


class AuthService:
    def create_user(self, email: str, password: str):
        """Create user payload."""
        return {
            "email": email,
            "password_hash": hash_password(password),
        }
