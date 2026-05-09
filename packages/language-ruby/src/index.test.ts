import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetRubyRipperWorker, RubyLanguageAdapter } from "./index.ts";

describe("ruby adapter", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    delete process.env.DSP_RUBY_RIPPER_COMMAND;
    delete process.env.DSP_RUBY_RIPPER_TIMEOUT_MS;
    delete process.env.DSP_RUBY_RIPPER_MAX_JOBS;
    await resetRubyRipperWorker();
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function installFakeRipperWorker(): void {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsp-ruby-worker-"));
    cleanupDirs.push(tempDir);
    const scriptPath = path.join(tempDir, "fake-ripper-worker.mjs");
    fs.writeFileSync(
      scriptPath,
      `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let crashed = false;

const defaultTokens = [
  { line: 1, type: "kw", value: "module" },
  { line: 1, type: "const", value: "Admin" },
  { line: 2, type: "kw", value: "class" },
  { line: 2, type: "const", value: "User" },
  { line: 3, type: "ident", value: "include" },
  { line: 3, type: "const", value: "Auditable" },
  { line: 4, type: "kw", value: "def" },
  { line: 4, type: "kw", value: "self" },
  { line: 4, type: "op", value: "." },
  { line: 4, type: "ident", value: "find_active" },
  { line: 5, type: "kw", value: "end" },
  { line: 6, type: "kw", value: "def" },
  { line: 6, type: "ident", value: "name" },
  { line: 7, type: "kw", value: "end" },
  { line: 8, type: "kw", value: "end" },
  { line: 9, type: "kw", value: "end" }
];

const constantTokens = [
  { line: 1, type: "kw", value: "module" },
  { line: 1, type: "const", value: "Billing" },
  { line: 2, type: "kw", value: "class" },
  { line: 2, type: "const", value: "CreateInvoice" },
  { line: 3, type: "kw", value: "def" },
  { line: 3, type: "ident", value: "call" },
  { line: 4, type: "const", value: "User" },
  { line: 5, type: "const", value: "UsersController" },
  { line: 6, type: "kw", value: "end" },
  { line: 7, type: "kw", value: "end" },
  { line: 8, type: "kw", value: "end" }
];

for await (const line of rl) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const content = String(request.content ?? "");
  if (content.includes("__timeout__")) {
    continue;
  }
  if (content.includes("__crash__") && !crashed) {
    crashed = true;
    process.exit(92);
  }
  if (content.includes("__syntax__")) {
    process.stdout.write(JSON.stringify({
      id: request.id,
      ok: false,
      error: { code: "syntax_error", message: "bad ruby syntax", syntaxError: true }
    }) + "\\n");
    continue;
  }
  process.stdout.write(JSON.stringify({
    id: request.id,
    ok: true,
    result: content.includes("UsersController") ? constantTokens : defaultTokens
  }) + "\\n");
}
`,
      "utf8"
    );
    process.env.DSP_RUBY_RIPPER_COMMAND = JSON.stringify([process.execPath, scriptPath]);
    process.env.DSP_RUBY_RIPPER_TIMEOUT_MS = "40";
    process.env.DSP_RUBY_RIPPER_MAX_JOBS = "2";
  }

  it("extracts classes/modules/methods and routes", async () => {
    installFakeRipperWorker();
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
    installFakeRipperWorker();
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

  it("falls back safely on Ruby syntax errors", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/models/user.rb",
      `
__syntax__
class User
  def name
  end
end
`
    );
    expect(parsed.entities.some((entity) => entity.kind === "class" && entity.name === "User")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("regex");
  });

  it("falls back and records timeout telemetry when Ripper stalls", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const parsed = (await adapter.parseFile(
      "app/models/user.rb",
      `
__timeout__
class User
  def name
  end
end
`
    )) as Awaited<ReturnType<RubyLanguageAdapter["parseFile"]>> & { telemetry?: { workerTimeouts?: number } };
    expect(parsed.entities.some((entity) => entity.kind === "class" && entity.name === "User")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("regex");
    expect(parsed.telemetry?.workerTimeouts).toBe(1);
  });

  it("restarts the Ruby parser worker after a crash", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const crashed = (await adapter.parseFile(
      "app/models/user.rb",
      `
__crash__
class User
  def name
  end
end
`
    )) as Awaited<ReturnType<RubyLanguageAdapter["parseFile"]>> & { telemetry?: { workerRestarts?: number } };
    expect(crashed.entities[0]?.provenance[0]?.source).toBe("regex");

    const recovered = await adapter.parseFile(
      "app/models/admin/user.rb",
      `
module Admin
  class User
    include Auditable
    def self.find_active
    end
  end
end
`
    );
    expect(recovered.entities.some((entity) => entity.kind === "module" && entity.name === "Admin")).toBe(true);
  });

  it("falls back when the Ruby runtime is unavailable", async () => {
    process.env.DSP_RUBY_RIPPER_COMMAND = JSON.stringify(["/definitely-missing-ruby-runtime"]);
    const adapter = new RubyLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/models/user.rb",
      `
class User
  def name
  end
end
`
    );
    expect(parsed.entities.some((entity) => entity.kind === "class" && entity.name === "User")).toBe(true);
    expect(parsed.entities[0]?.provenance[0]?.source).toBe("regex");
  });

  it("maps Rails Zeitwerk constants to conventional files", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/services/billing/create_invoice.rb",
      `
module Billing
  class CreateInvoice
    def call
      User.find(1)
      UsersController
    end
  end
end
`
    );
    const relations = adapter.extractRelations(parsed, parsed.entities);
    expect(parsed.entities.find((entity) => entity.kind === "class")?.metadata?.zeitwerkConstant).toBe(
      "Billing::CreateInvoice"
    );
    expect(relations.some((relation) => relation.kind === "uses" && relation.to === "file:app/models/user.rb")).toBe(true);
    expect(
      relations.some((relation) => relation.kind === "uses" && relation.to === "file:app/controllers/users_controller.rb")
    ).toBe(true);
  });

  it("indexes Bundler dependencies from Gemfile and Gemfile.lock", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const gemfile = await adapter.parseFile(
      "Gemfile",
      `
source "https://rubygems.org"
gem "rails", "~> 7.1"
gem "pg"
`
    );
    const lockfile = await adapter.parseFile(
      "Gemfile.lock",
      `
GEM
  specs:
    puma (6.4.0)
`
    );
    expect(gemfile.entities.some((entity) => entity.uid === "unknown:external/ruby-gems#rails")).toBe(true);
    expect(gemfile.relations.some((relation) => relation.kind === "depends_on" && relation.to === "unknown:external/ruby-gems#pg")).toBe(true);
    expect(lockfile.entities.some((entity) => entity.uid === "unknown:external/ruby-gems#puma")).toBe(true);
  });

  it("links Ruby spec and test files to implementation files", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const spec = await adapter.parseFile("spec/models/user_spec.rb", "RSpec.describe User do\nend\n");
    const minitest = await adapter.parseFile("test/controllers/users_controller_test.rb", "class UsersControllerTest\nend\n");
    expect(
      spec.relations.some((relation) => relation.kind === "tests" && relation.to === "file:app/models/user.rb")
    ).toBe(true);
    expect(
      minitest.relations.some(
        (relation) => relation.kind === "tests" && relation.to === "file:app/controllers/users_controller.rb"
      )
    ).toBe(true);
  });

  it("indexes ActiveRecord associations, validations, scopes, callbacks and enums", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const parsed = await adapter.parseFile(
      "app/models/order.rb",
      `
class Order < ApplicationRecord
  belongs_to :user
  has_many :line_items
  validates :total_cents, presence: true
  scope :paid, -> { where(paid: true) }
  before_save :normalize_total
  enum :status, { pending: 0, paid: 1 }
end
`
    );
    const entities = adapter.extractEntities(parsed);
    const relations = adapter.extractRelations(parsed, entities);
    expect(entities.some((entity) => entity.kind === "constant" && entity.metadata?.railsKind === "association")).toBe(true);
    expect(entities.some((entity) => entity.kind === "method" && entity.metadata?.railsKind === "scope")).toBe(true);
    expect(relations.some((relation) => relation.kind === "depends_on" && relation.to === "file:app/models/user.rb")).toBe(true);
    expect(relations.some((relation) => relation.kind === "depends_on" && relation.to === "file:app/models/line_item.rb")).toBe(true);
  });

  it("maps Rails routes to controller action methods", async () => {
    installFakeRipperWorker();
    const adapter = new RubyLanguageAdapter();
    const parsed = await adapter.parseFile(
      "config/routes.rb",
      `
get "/users", to: "users#index"
resources :accounts
`
    );
    const relations = adapter.extractRelations(parsed, parsed.entities);
    expect(parsed.entities.some((entity) => entity.kind === "route" && entity.name === "/users")).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "routes_to" &&
          relation.to === "method:app/controllers/users_controller.rb#UsersController.index"
      )
    ).toBe(true);
    expect(
      relations.some(
        (relation) =>
          relation.kind === "routes_to" &&
          relation.to === "method:app/controllers/accounts_controller.rb#AccountsController.index"
      )
    ).toBe(true);
  });
});
