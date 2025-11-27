-- Add contact_source field to contacts table
alter table "public"."contacts" add column "contact_source" text;

-- Update contacts_summary view to include contact_source
drop view if exists "public"."contacts_summary";

create view "public"."contacts_summary"
as
select 
    co.*,
    c.name as company_name,
    count(distinct t.id) as nb_tasks
from
    "public"."contacts" co
left join
    "public"."tasks" t on co.id = t.contact_id
left join
    "public"."companies" c on co.company_id = c.id
group by
    co.id, c.name;

-- Function to auto-create a deal when a company is created
create or replace function "public"."auto_create_deal_for_company"()
returns trigger as $$
declare
  lead_deal_count integer;
  new_deal_id bigint;
begin
  -- Only create deal if company has a sales_id
  if NEW.sales_id is not null then
    -- Count existing deals in "lead" stage that are not archived
    select count(*) into lead_deal_count
    from "public"."deals"
    where stage = 'lead' and (archived_at is null or archived_at > now());
    
    -- Create the deal
    insert into "public"."deals" (
      name,
      company_id,
      contact_ids,
      category,
      stage,
      description,
      amount,
      created_at,
      updated_at,
      expected_closing_date,
      sales_id,
      index
    ) values (
      NEW.name,
      NEW.id,
      ARRAY[]::bigint[],
      '',
      'lead',
      '',
      0,
      NEW.created_at,
      NEW.created_at,
      null,
      NEW.sales_id,
      coalesce(lead_deal_count, 0)
    )
    returning id into new_deal_id;
  end if;
  
  return NEW;
end;
$$ language plpgsql;

-- Create trigger to call the function after company insert
drop trigger if exists "trigger_auto_create_deal_for_company" on "public"."companies";
create trigger "trigger_auto_create_deal_for_company"
  after insert on "public"."companies"
  for each row
  execute function "public"."auto_create_deal_for_company"();

