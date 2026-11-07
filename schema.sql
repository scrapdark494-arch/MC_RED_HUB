-- MC RED HUB Cloud v2
-- Ejecuta este archivo completo en Supabase > SQL Editor > New query.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id text primary key,
  username text not null,
  username_norm text not null unique,
  avatar_path text not null,
  password_hash text, -- MC RED HUB 4.0 no lo usa: perfiles Nick+foto con token privado del dispositivo.
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists password_hash text;
alter table public.profiles alter column password_hash drop not null;

create table if not exists public.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.profiles(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists api_tokens_user_idx on public.api_tokens(user_id);

create table if not exists public.mods (
  id text primary key,
  title text not null,
  description text not null,
  version text not null,
  category text not null,
  author_id text not null references public.profiles(id),
  author_name text not null,
  author_avatar_path text,
  file_name text,
  file_path text,
  external_url text,
  cover_path text,
  file_size bigint,
  created_at timestamptz not null default now(),
  downloads bigint not null default 0
);
create index if not exists mods_created_idx on public.mods(created_at desc);
create index if not exists mods_category_idx on public.mods(category);

create table if not exists public.skins (
  id text primary key,
  name text not null,
  author_id text not null references public.profiles(id),
  author_name text not null,
  author_avatar_path text,
  file_name text not null,
  file_path text not null,
  created_at timestamptz not null default now()
);
create index if not exists skins_created_idx on public.skins(created_at desc);

create table if not exists public.servers (
  id text primary key,
  name text not null,
  address text not null,
  port integer not null,
  version text not null,
  requirements text not null default '',
  description text not null,
  creator_id text not null references public.profiles(id),
  creator text not null,
  creator_avatar text,
  created_at timestamptz not null default now()
);
create index if not exists servers_created_idx on public.servers(created_at desc);

create table if not exists public.worlds (
  id text primary key,
  name text not null,
  file_name text not null,
  file_path text not null,
  file_size bigint not null,
  author_id text not null references public.profiles(id),
  author_name text not null,
  created_at timestamptz not null default now(),
  downloads bigint not null default 0
);
create index if not exists worlds_created_idx on public.worlds(created_at desc);

create table if not exists public.messages (
  id text primary key,
  server_id text not null references public.servers(id) on delete cascade,
  user_id text not null references public.profiles(id),
  user_name text not null,
  user_avatar text,
  message text not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_server_created_idx on public.messages(server_id, created_at desc);

-- Las tablas solo se consultan desde el servidor Node mediante la clave service role.
-- No se permite acceso directo desde las apps/navegadores con las claves anon/authenticated.
alter table public.profiles enable row level security;
alter table public.api_tokens enable row level security;
alter table public.mods enable row level security;
alter table public.skins enable row level security;
alter table public.servers enable row level security;
alter table public.worlds enable row level security;
alter table public.messages enable row level security;
revoke all on public.profiles, public.api_tokens, public.mods, public.skins, public.servers, public.worlds, public.messages from anon, authenticated;
grant all on public.profiles, public.api_tokens, public.mods, public.skins, public.servers, public.worlds, public.messages to service_role;

-- Almacén privado: los archivos solo se entregan mediante enlaces firmados de corta duración.
insert into storage.buckets (id, name, public, file_size_limit)
values ('mcrh-files', 'mcrh-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;


-- Extensiones MC RED HUB 3.0: contadores, reseñas y registro de actividad.
alter table public.skins add column if not exists downloads bigint not null default 0;

create table if not exists public.reviews (
  id text primary key,
  target_type text not null check (target_type in ('mod','skin','world','server')),
  target_id text not null,
  target_name text not null,
  user_id text not null references public.profiles(id) on delete cascade,
  user_name text not null,
  rating smallint not null check (rating between 1 and 5),
  comment text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (target_type,target_id,user_id)
);
create index if not exists reviews_target_idx on public.reviews(target_type,target_id,created_at desc);
create index if not exists reviews_created_idx on public.reviews(created_at desc);

create table if not exists public.activity (
  id text primary key,
  action text not null,
  content_type text not null,
  content_id text,
  content_name text not null,
  user_id text references public.profiles(id) on delete set null,
  user_name text not null,
  created_at timestamptz not null default now()
);
create index if not exists activity_created_idx on public.activity(created_at desc);

alter table public.reviews enable row level security;
alter table public.activity enable row level security;
revoke all on public.reviews, public.activity from anon, authenticated;
grant all on public.reviews, public.activity to service_role;

-- Incremento atómico de descargas para evitar perder conteos simultáneos.
create or replace function public.mcrh_increment_download(p_kind text,p_id text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare result_count bigint;
begin
  if p_kind='mod' then
    update public.mods set downloads=downloads+1 where id=p_id returning downloads into result_count;
  elsif p_kind='skin' then
    update public.skins set downloads=downloads+1 where id=p_id returning downloads into result_count;
  elsif p_kind='world' then
    update public.worlds set downloads=downloads+1 where id=p_id returning downloads into result_count;
  else
    raise exception 'Tipo de descarga no permitido';
  end if;
  return result_count;
end;
$$;
revoke all on function public.mcrh_increment_download(text,text) from public, anon, authenticated;
grant execute on function public.mcrh_increment_download(text,text) to service_role;
