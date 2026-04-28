from .crypto import hash_token


def validate_token(token):
    return hash_token(token).startswith("hashed:")
