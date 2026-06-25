import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { createContainer, createModule } from "../../src";

const MEASUREMENT_ENABLED = process.env.MEASURE_INSTANTIATION === "1";
const measureIt = MEASUREMENT_ENABLED ? it : it.skip;

const ITERATIONS = Number(process.env.MEASURE_ITERATIONS ?? 25_000);
const ROUNDS = Number(process.env.MEASURE_ROUNDS ?? 7);
const WARMUP_ITERATIONS = Number(process.env.MEASURE_WARMUP ?? 2_000);

class AppConfig {
  constructor(
    readonly region: string,
    readonly multiplier: number,
  ) {}
}

class Clock {
  constructor(private readonly epoch: number) {}

  now(input: number): number {
    return this.epoch + input;
  }
}

class Logger {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  mark(input: number): number {
    return this.clock.now(input) ^ this.config.multiplier;
  }
}

class DbClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  query(input: number): number {
    return this.logger.mark(input) + this.config.region.length;
  }
}

class UserRepo {
  constructor(private readonly db: DbClient) {}

  find(input: number): number {
    return this.db.query(input) * 3;
  }
}

class AuditRepo {
  constructor(
    private readonly db: DbClient,
    private readonly logger: Logger,
  ) {}

  record(input: number): number {
    return this.db.query(input) ^ this.logger.mark(input + 1);
  }
}

class UserService {
  constructor(
    private readonly users: UserRepo,
    private readonly audit: AuditRepo,
  ) {}

  load(input: number): number {
    return this.users.find(input) + this.audit.record(input);
  }
}

class UserController {
  constructor(
    private readonly service: UserService,
    private readonly logger: Logger,
  ) {}

  handle(input: number): number {
    return this.service.load(input) ^ this.logger.mark(input + 2);
  }
}

const BenchModule = createModule("Bench", (m) =>
  m
    .single("config", () => new AppConfig("eu-west", 17))
    .single("clock", () => new Clock(1_700_000_000))
    .single("logger", (r) => new Logger(r.Bench.config(), r.Bench.clock()))
    .single("db", (r) => new DbClient(r.Bench.config(), r.Bench.logger()))
    .single("userRepo", (r) => new UserRepo(r.Bench.db()))
    .single("auditRepo", (r) => new AuditRepo(r.Bench.db(), r.Bench.logger()))
    .single("service", (r) => new UserService(r.Bench.userRepo(), r.Bench.auditRepo()))
    .single("controller", (r) => new UserController(r.Bench.service(), r.Bench.logger())),
);

interface Measurement {
  label: string;
  bestMs: number;
  medianMs: number;
  medianNsPerOp: number;
  operationsPerSecond: number;
}

let blackhole = 0;

function buildManualController(): UserController {
  const config = new AppConfig("eu-west", 17);
  const clock = new Clock(1_700_000_000);
  const logger = new Logger(config, clock);
  const db = new DbClient(config, logger);
  const userRepo = new UserRepo(db);
  const auditRepo = new AuditRepo(db, logger);
  const service = new UserService(userRepo, auditRepo);
  return new UserController(service, logger);
}

function measure(label: string, action: (iteration: number) => number): Measurement {
  for (let i = 0; i < WARMUP_ITERATIONS; i += 1) blackhole ^= action(i);

  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const startedAt = performance.now();
    for (let i = 0; i < ITERATIONS; i += 1) blackhole ^= action(i);
    samples.push(performance.now() - startedAt);
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const medianMs = sorted[Math.floor(sorted.length / 2)]!;
  return {
    label,
    bestMs: sorted[0]!,
    medianMs,
    medianNsPerOp: (medianMs * 1_000_000) / ITERATIONS,
    operationsPerSecond: ITERATIONS / (medianMs / 1_000),
  };
}

function renderMeasurements(measurements: Measurement[]): string {
  const rows = measurements.map(
    (measurement) =>
      `${measurement.label.padEnd(34)} ${measurement.bestMs.toFixed(2).padStart(10)} ${measurement.medianMs
        .toFixed(2)
        .padStart(12)} ${measurement.medianNsPerOp.toFixed(0).padStart(12)} ${measurement.operationsPerSecond
        .toFixed(0)
        .padStart(12)}`,
  );
  return [
    "",
    "Instantiation measurement",
    `iterations=${ITERATIONS} rounds=${ROUNDS} warmup=${WARMUP_ITERATIONS}`,
    "",
    `${"case".padEnd(34)} ${"best ms".padStart(10)} ${"median ms".padStart(12)} ${"ns/op".padStart(
      12,
    )} ${"ops/sec".padStart(12)}`,
    "-".repeat(86),
    ...rows,
    `blackhole=${blackhole}`,
  ].join("\n");
}

describe("instantiation measurement", () => {
  measureIt("compares manual construction with terrain resolution", async () => {
    const manualController = buildManualController();
    const terrainApp = createContainer({ parts: [BenchModule] });
    const terrainController = terrainApp.Bench.controller();

    const measurements = [
      measure("manual fresh graph", (iteration) => buildManualController().handle(iteration)),
      measure("terrain fresh container+resolve", (iteration) => {
        const app = createContainer({ parts: [BenchModule] });
        return app.Bench.controller().handle(iteration);
      }),
      measure("manual cached controller", (iteration) => manualController.handle(iteration)),
      measure("terrain cached accessor", (iteration) => terrainApp.Bench.controller().handle(iteration)),
      measure("terrain cached controller", (iteration) => terrainController.handle(iteration)),
    ];

    process.stdout.write(`${renderMeasurements(measurements)}\n`);
    expect(Number.isFinite(blackhole)).toBe(true);
    await terrainApp.dispose();
  });
});
