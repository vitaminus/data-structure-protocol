pub fn validate_token(token: &str) -> bool {
    token.starts_with("hashed:")
}
