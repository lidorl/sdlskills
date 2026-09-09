# CLAUDE.stack.md — worked example (NestJS + Prisma + React admin)

This is an **example** of the stack-conventions half that pairs with `CLAUDE.process.md`. Replace it wholesale with your project's actual stack. `/setup-sdlc` helps generate a first version by mapping your repo.

The process contract (lifecycle, tiers, Definition of Done, ADR format, status model) lives in `CLAUDE.process.md` and does not change per stack. Only this file does.

---

## Project

${PROJECT DESCRIPTION}

## Commands

```bash
# Development
nest start --watch

# Build
nest build

# Run production build
node dist/main.js

# Tests (integration — run against a test DB)
jest
jest --testPathPattern=offers        # single file/pattern

# Database
prisma migrate dev                   # apply migrations + regenerate client
prisma migrate deploy                # production migrations (no client regen)
prisma generate                      # regenerate client after schema changes
```

## Architecture

### Layer rules

```
Controllers → Services → PrismaService / lib/geo.ts → PostgreSQL
```

- Controllers parse `req`, call one service method, return the response. No Prisma, no business logic.
- Services own all business logic and DB access. No `req`/`res` references.
- Raw PostGIS queries go through helpers in `src/lib/geo.ts` via `PrismaService.$queryRaw`.

### Module structure

One NestJS module per resource under `src/modules/<resource>/`:

```
src/modules/<resource>/
├── <resource>.module.ts
├── <resource>.controller.ts
├── <resource>.service.ts
└── dto/
    ├── create-<resource>.dto.ts
    └── update-<resource>.dto.ts
```

`OffersModule` also contains `claims.controller.ts` + `claims.service.ts` for offer fulfillment (cap enforcement for `GLOBAL_CAPPED` and `USER_UNIQUE` offers).

`PrismaModule` and `ConfigModule` are `@Global()` — do not re-import them in feature modules.

### Validation

Use `createZodDto(schema)` from `nestjs-zod` for every DTO. `ZodValidationPipe` is applied globally in `main.ts` — no per-route pipe needed. Zod schemas drive both runtime validation and the generated OpenAPI spec; do not add manual `@ApiProperty()` on `nestjs-zod` DTOs.

### Authentication

Three guard types — apply the right one per route:

| Guard | File | Protects |
|---|---|---|
| `JwtAuthGuard` | `common/guards/jwt.guard.ts` | All admin endpoints |
| `GameApiKeyGuard` | `common/guards/game-api-key.guard.ts` | Game distribution endpoints (`X-Api-Key` → looks up `Game`) |
| `VendorApiKeyGuard` | `common/guards/vendor-api-key.guard.ts` | Offer fulfillment endpoints (`X-Api-Key` → looks up `Vendor`) |

Fulfillment endpoints accept either admin JWT or vendor API key — apply both guards so either satisfies auth.

Discord login: `DiscordStrategy.validate()` checks the Discord user ID against the `DISCORD_ALLOWED_USER_IDS` env var (comma-separated) and throws `ForbiddenException` before any DB lookup if the ID is not on the list.

### Error handling

Throw typed errors from services (e.g. `NotFoundError`, `ValidationError` defined in `src/types/index.ts`). The global `HttpExceptionFilter` in `common/filters/` maps them to HTTP responses. Controllers have no try/catch.

### Config & environment

Access all env vars via injected `ConfigService` — never `process.env` directly. Required variables: `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `NODE_ENV`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_CALLBACK_URL`, `DISCORD_ALLOWED_USER_IDS`.

### Key data model decisions

- `api_key` on `Game` and `Vendor` is **always generated server-side** — never accept it as user input.
- `Offer.fulfillment_type` is either `GLOBAL_CAPPED` (atomic counter on `Offer.redemption_count`) or `USER_UNIQUE` (`UserOfferClaim` rows, one per `(offer_id, player_id)`).
- For `GLOBAL_CAPPED` cap enforcement use a single atomic `UPDATE … WHERE redemption_count < max_redemptions` — do not read then write.
- `UserOfferClaim.status` transitions are one-way: `AVAILABLE → USED` or `AVAILABLE → EXPIRED`.
- `player_id` on `UserOfferClaim` is an opaque string from the caller — no lookup or validation in our system.
- `User.discord_id` is nullable; set only when an account is linked to a Discord identity.

### Security Review triggers (maps to the Definition of Done)

Run `/security-review` when the change involves authentication/authorization, a new externally-exposed endpoint, data-access control, or API-key generation/validation.

### TypeScript

CommonJS modules (`"module": "CommonJS"`). `experimentalDecorators` and `emitDecoratorMetadata` are required in `tsconfig.json` for NestJS DI to work. `main.ts` must import `reflect-metadata` before any NestJS imports.

### React admin console

See `examples/react-components/` in the kit for the Vite + React + shadcn/ui + TanStack Query conventions. Copy it to `.claude/skills/react-components/` if the project has a React console.
