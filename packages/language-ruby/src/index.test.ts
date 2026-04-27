import { describe, expect, it } from "vitest";
import { RubyLanguageAdapter } from "./index.js";

describe("ruby adapter", () => {
  it("extracts classes/modules/methods and routes", async () => {
    const adapter = new RubyLanguageAdapter();
    const parsedModel = await adapter.parseFile(
      "app/models/user.rb",
      `
module Accounts
  class User
    include Comparable
    def self.create(email)
      User.new(email)
    end

    def valid?
      true
    end
  end
end
`
    );
    const entities = adapter.extractEntities(parsedModel);
    const relations = adapter.extractRelations(parsedModel, entities);
    expect(entities.some((entity) => entity.kind === "module")).toBe(true);
    expect(entities.some((entity) => entity.kind === "class")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method")).toBe(true);
    expect(relations.some((relation) => relation.kind === "implements")).toBe(true);

    const parsedRoutes = await adapter.parseFile(
      "config/routes.rb",
      `get "/users", to: "users#index"`
    );
    expect(parsedRoutes.entities.some((entity) => entity.kind === "route")).toBe(true);
  });

  it("uses Ripper to extract nested classes, methods and mixins", async () => {
    const adapter = new RubyLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/models/admin/user.rb",
      `
module Admin
  class User
    include Auditable

    def self.find_active
    end

    def name
    end
  end
end
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "module" && entity.name === "Admin")).toBe(true);
    expect(entities.some((entity) => entity.kind === "class" && entity.name === "User")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method" && entity.name === "find_active")).toBe(true);
    expect(relations.some((relation) => relation.kind === "implements" && relation.reason === "include Auditable")).toBe(true);
  });
});
