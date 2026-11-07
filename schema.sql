-- Marli Cab database schema. Paste into Supabase > SQL Editor > Run.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  role text not null default 'rider' check (role in ('rider','driver','admin')),
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.rides (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.profiles(id) on delete cascade,
  driver_id uuid references public.profiles(id),
  pickup_text text not null default '',
  dropoff_text text not null default '',
  pickup_lat double precision not null,
  pickup_lng double precision not null,
  drop_lat double precision not null,
  drop_lng double precision not null,
  distance_km numeric(8,2) not null default 0,
  fare numeric(10,2) not null default 0,
  status text not null default 'requested'
    check (status in ('requested','accepted','arrived','in_progress','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists rides_status_idx on public.rides(status);
create index if not exists rides_rider_idx on public.rides(rider_id);
create index if not exists rides_driver_idx on public.rides(driver_id);

-- Helper checks (security definer avoids recursive policy lookups)
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_approved_driver() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and role = 'driver' and approved);
$$;

-- Create a profile automatically on sign-up (admin can never be self-assigned)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := coalesce(new.raw_user_meta_data->>'role', 'rider');
begin
  if r not in ('rider','driver') then r := 'rider'; end if;
  insert into public.profiles (id, full_name, phone, role, approved)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', ''),
          coalesce(new.raw_user_meta_data->>'phone', ''),
          r,
          r = 'rider');
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Only admins may change role/approved
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() and auth.uid() is not null then
    new.role := old.role;
    new.approved := old.approved;
  end if;
  return new;
end $$;

drop trigger if exists protect_profile_trg on public.profiles;
create trigger protect_profile_trg before update on public.profiles
  for each row execute function public.protect_profile();

-- Keep updated_at fresh and stop riders/drivers editing fares or locations
create or replace function public.protect_ride() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if not public.is_admin() and auth.uid() is not null then
    new.rider_id := old.rider_id;
    new.fare := old.fare;
    new.distance_km := old.distance_km;
    new.pickup_lat := old.pickup_lat; new.pickup_lng := old.pickup_lng;
    new.drop_lat := old.drop_lat;     new.drop_lng := old.drop_lng;
    new.pickup_text := old.pickup_text; new.dropoff_text := old.dropoff_text;
    -- a driver can only claim an unassigned ride as themselves
    if old.driver_id is not null then new.driver_id := old.driver_id; end if;
    -- riders may only cancel; they cannot move a ride along or complete it
    if auth.uid() = old.rider_id and new.status is distinct from old.status and new.status <> 'cancelled' then
      new.status := old.status;
    end if;
    -- once claimed, a ride can't go back to 'requested'
    if old.driver_id is not null and new.status = 'requested' then
      new.status := old.status;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists protect_ride_trg on public.rides;
create trigger protect_ride_trg before update on public.rides
  for each row execute function public.protect_ride();

alter table public.profiles enable row level security;
alter table public.rides enable row level security;

-- profiles
drop policy if exists "profiles read" on public.profiles;
create policy "profiles read" on public.profiles for select to authenticated using (true);
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- rides: read
drop policy if exists "rides read" on public.rides;
create policy "rides read" on public.rides for select to authenticated using (
  rider_id = auth.uid()
  or driver_id = auth.uid()
  or (status = 'requested' and public.is_approved_driver())
  or public.is_admin()
);

-- rides: create (riders only, as themselves, starting as requested)
drop policy if exists "rides insert" on public.rides;
create policy "rides insert" on public.rides for insert to authenticated
  with check (rider_id = auth.uid() and status = 'requested' and driver_id is null);

-- rides: update
drop policy if exists "rides update" on public.rides;
create policy "rides update" on public.rides for update to authenticated
  using (
    rider_id = auth.uid()
    or driver_id = auth.uid()
    or (status = 'requested' and public.is_approved_driver())
    or public.is_admin()
  )
  with check (
    rider_id = auth.uid()
    or driver_id = auth.uid()
    or public.is_admin()
  );

-- Live updates
alter publication supabase_realtime add table public.rides;

-- After you sign up with your own account, make yourself admin:
--   update public.profiles set role = 'admin', approved = true where id = (select id from auth.users where email = 'YOUR@EMAIL');
