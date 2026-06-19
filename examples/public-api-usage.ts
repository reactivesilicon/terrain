/**
 * terrain — usage
 *
 * Run with:  bun examples/public-api-usage.ts
 *
 * The composition API: define modules by name, compose them into a container,
 * and resolve through typed namespaces — no tokens, no manual wiring. Tokens
 * still exist under the hood; this is the surface applications use.
 */

import { createContainer, createModule } from "../src";

interface Logger {
  info(msg: string): void;
}
interface UserRepo {
  find(id: string): string | null;
}

class ConsoleLogger implements Logger {
  info(msg: string): void {
    console.log(`  [log] ${msg}`);
  }
}

class TestLogger implements Logger {
  info(msg: string): void {
    console.log(`  [fake] ${msg}`);
  }
}

class InMemoryUserRepo implements UserRepo {
  constructor(
    private readonly logger: Logger,
    private readonly rows: ReadonlyMap<string, string>,
  ) {}

  find(id: string): string | null {
    this.logger.info(`find user ${id}`);
    return this.rows.get(id) ?? null;
  }
}

class FindUserUseCase {
  constructor(
    private readonly users: UserRepo,
    private readonly logger: Logger,
  ) {}

  execute(id: string): string {
    this.logger.info(`run find-user use case for ${id}`);
    const user = this.users.find(id);
    return user ? `Found ${user}` : "User not found";
  }
}

// Infra: a sync logger and an async-loaded config.
const infraModule = createModule("Infra", (m) =>
  m
    .single("logger", (): Logger => new ConsoleLogger())
    .singleAsync("config", async () => {
      await new Promise((r) => setTimeout(r, 10)); // simulate loading
      return { env: "prod" };
    }),
);

// Data uses Infra — its provider resolver exposes imports under their names
// (r.Infra.logger()). A sync provider sees only the sync entries of imports.
const dataModule = createModule("Data", { uses: [infraModule] }, (m) =>
  m.single("userRepo", (r): UserRepo => new InMemoryUserRepo(r.Infra.logger(), new Map([["1", "Ada"]]))),
);

// Use cases are application classes composed from lower-level dependencies.
const actionsModule = createModule("UseCases", { uses: [dataModule, infraModule] }, (m) =>
  m.single("findUser", (r): FindUserUseCase => new FindUserUseCase(r.Data.userRepo(), r.Infra.logger())),
);

async function main() {
  // Passing Data auto-wires Infra; passing Infra too exposes its namespace.
  const app = createContainer(infraModule, dataModule, actionsModule);

  console.log("user:", app.Data.userRepo().find("1")); // typed, token-free
  console.log("use case:", app.UseCases.findUser().execute("1"));
  console.log("config:", await app.Infra.config()); // async entry → Promise

  // A request scope, created and disposed around the callback.
  await app.scope((req) => {
    console.log("in scope:", req.UseCases.findUser().execute("1"));
  });

  await app.dispose();

  // Testing: override Infra's logger without touching Data's wiring.
  const FakeInfra = infraModule.override((o) => o.with("logger", (): Logger => new TestLogger()));
  const testApp = createContainer(infraModule, dataModule, actionsModule, FakeInfra);
  console.log("with fake logger:", testApp.UseCases.findUser().execute("1"));
  await testApp.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
