pub struct User {
    pub name: String,
}

impl User {
    pub fn new(name: &str) -> User {
        User {
            name: name.to_string(),
        }
    }
}
