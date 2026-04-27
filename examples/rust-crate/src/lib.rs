pub mod user;
use user::User;

pub fn create_user(name: &str) -> User {
    User::new(name)
}
