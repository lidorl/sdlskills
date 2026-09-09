---
name: react-components
description: Use when building any React component, page, feature, or setting up the React admin console — covers Vite + React + TypeScript strict + shadcn/ui + Tailwind + TanStack Query conventions for this project
---

# React Components

> **Example skill.** Not part of the core SDLC kit. Copy to `.claude/skills/react-components/` and adapt if the project has a React admin console; otherwise ignore.

## Overview

This project's React admin console uses **Vite + React 18 + TypeScript (strict)**, **shadcn/ui + Tailwind** for UI, and **TanStack Query** for server state. All components are functional, all state is typed, and all data fetching goes through query/mutation hooks.

## Project Structure

The React app lives inside the monorepo at `apps/admin/` (or `web/` — check root if not yet scaffolded):

```
src/
  components/        # Shared, reusable UI components
    ui/              # shadcn/ui generated components (DO NOT edit)
    [feature]/       # Feature-specific shared components
  pages/             # Route-level page components
    [resource]/
      index.tsx      # List/overview page
      [id].tsx       # Detail/edit page
  hooks/             # Custom hooks (queries, mutations, local state)
    use-[resource].ts
  lib/
    api.ts           # Typed fetch helpers
    utils.ts         # shadcn/ui utility (cn function)
  types/             # Shared TypeScript types (mirror API response shapes)
```

## Component Rules

### Every component
- Functional component with explicit return type
- Props typed via `interface`, not `type` alias, named `[ComponentName]Props`
- No `React.FC` — use direct function signature

```tsx
// ✅
interface UserCardProps {
  userId: string;
  onDelete?: (id: string) => void;
}

export function UserCard({ userId, onDelete }: UserCardProps) {
  return <div>...</div>;
}

// ❌ — avoid
const UserCard: React.FC<{ userId: string }> = ({ userId }) => ...
```

### File naming
- One component per file, filename = component name in kebab-case
- `user-card.tsx` exports `UserCard`
- `index.tsx` re-exports from a directory when grouping related components

## shadcn/ui + Tailwind

- Install components via `npx shadcn@latest add <component>` — never copy-paste manually
- Compose shadcn primitives; don't build from scratch what shadcn covers
- Use `cn()` from `src/lib/utils.ts` to merge Tailwind classes conditionally:

```tsx
import { cn } from '@/lib/utils';

<div className={cn('base-class', isActive && 'active-class', className)} />
```

- Keep Tailwind inline; extract to a component only when reused 3+ times
- No custom CSS files — Tailwind only

## TanStack Query Patterns

### Queries (reading data)

Every resource gets a custom hook in `src/hooks/`:

```tsx
// hooks/use-vendors.ts
import { useQuery } from '@tanstack/react-query';
import { fetchVendors } from '@/lib/api';
import type { Vendor } from '@/types';

export const vendorKeys = {
  all: ['vendors'] as const,
  detail: (id: string) => ['vendors', id] as const,
};

export function useVendors() {
  return useQuery({
    queryKey: vendorKeys.all,
    queryFn: fetchVendors,
  });
}

export function useVendor(id: string) {
  return useQuery({
    queryKey: vendorKeys.detail(id),
    queryFn: () => fetchVendor(id),
    enabled: Boolean(id),
  });
}
```

### Mutations (writing data)

```tsx
// hooks/use-create-vendor.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { vendorKeys } from './use-vendors';

export function useCreateVendor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createVendor,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: vendorKeys.all });
    },
  });
}
```

### In components — always handle all states

```tsx
const { data, isLoading, isError } = useVendors();

if (isLoading) return <Skeleton className="h-8 w-full" />;
if (isError) return <Alert variant="destructive">Failed to load vendors.</Alert>;
```

Never render data without guarding `isLoading` and `isError`.

## API Layer

All fetch calls in `src/lib/api.ts` — never `fetch` inline in components or hooks:

```ts
// lib/api.ts
const BASE = import.meta.env.VITE_API_URL;

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export const fetchVendors = () => apiFetch<Vendor[]>('/vendors');
export const fetchVendor = (id: string) => apiFetch<Vendor>(`/vendors/${id}`);
```

## TypeScript Rules (strict mode)

- No `any` — use `unknown` + type narrowing if shape is uncertain
- API response types in `src/types/` mirror the backend Prisma schema
- Non-null assertion (`!`) only when TypeScript can't infer but you've guarded — add a comment
- Enable path alias `@/` → `src/` in `tsconfig.json` and `vite.config.ts`

## Forms

Use **React Hook Form + zod** (pairs naturally with shadcn Form component):

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

const schema = z.object({ name: z.string().min(1) });
type FormValues = z.infer<typeof schema>;

export function VendorForm() {
  const form = useForm<FormValues>({ resolver: zodResolver(schema) });
  const { mutate } = useCreateVendor();
  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((v) => mutate(v))}>...</form>
    </Form>
  );
}
```

## Page Pattern

Pages are thin — they compose hooks and components, no logic of their own:

```tsx
// pages/vendors/index.tsx
export default function VendorsPage() {
  const { data: vendors, isLoading, isError } = useVendors();
  if (isLoading) return <PageSkeleton />;
  if (isError) return <ErrorBanner />;
  return (
    <PageLayout title="Vendors">
      <VendorTable vendors={vendors} />
    </PageLayout>
  );
}
```

## Common Mistakes

| Mistake | Fix |
|---|---|
| Fetching in `useEffect` | Use TanStack Query hook |
| Editing files in `src/components/ui/` | Re-run `shadcn add` to regenerate |
| Passing raw `fetch` response without type | Type the `apiFetch<T>` generic |
| Skipping loading/error states | Always guard with `isLoading` / `isError` |
| Inline `fetch` in a component | Move to `lib/api.ts` |
| Using `any` for API response | Define type in `src/types/` |
| Class components | Functional only |
