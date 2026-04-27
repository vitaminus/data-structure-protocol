module Accounts
  class User
    include Comparable

    def self.create(email)
      User.new(email)
    end

    def initialize(email)
      @email = email
    end
  end
end
