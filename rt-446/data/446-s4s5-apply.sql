-- RT-446 S4/S5 lab-only catalogue change (owner-approved 2026-10-23). Before-values: 446-s4s5-before.txt
-- S4: RT9 Item 03 price 7.2500 -> 8.0000.  S5: «باراسيتامول شراب أطفال 120 مل» is_active true -> false.
begin;
select set_config('app.current_tenant','9be1cac9-f6dc-4e0b-b2bb-6f4a4145801a',true);
update tenant_products set default_price = 8.0000, updated_at = now() where id = 'a0573883-2c8c-4ac8-8329-d4722ba6b737' returning name, default_price, updated_at;
update tenant_products set is_active = false, updated_at = now() where id = '1b0972cd-eecf-423b-90b6-0796317e4e69' returning name, is_active, updated_at;
commit;
