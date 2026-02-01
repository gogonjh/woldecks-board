-- Supabase schema for Woldecks board
create extension if not exists pgcrypto;

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text not null,
  content text not null,
  pw_salt_hex text not null,
  pw_iterations integer not null,
  pw_digest text not null,
  pw_keylen integer not null,
  pw_hash_hex text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz null
);

create index if not exists posts_created_at_idx on public.posts (created_at desc);

create table if not exists public.view_tokens (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  token_hash text not null,
  token_salt text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists view_tokens_post_id_idx on public.view_tokens (post_id);
create index if not exists view_tokens_expires_at_idx on public.view_tokens (expires_at);

create table if not exists public.admin_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null,
  token_salt text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists admin_sessions_expires_at_idx on public.admin_sessions (expires_at);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists posts_updated_at on public.posts;
create trigger posts_updated_at
before update on public.posts
for each row execute function public.set_updated_at();

alter table public.posts enable row level security;
alter table public.view_tokens enable row level security;
alter table public.admin_sessions enable row level security;
