\# Live Schema Snapshot



\*\*Generated:\*\* 2026-05-01

\*\*After:\*\* Sprint 5 Phase 1

\*\*Source:\*\* Supabase production, public schema



This is a raw column dump for all tables in the public schema. Use this as a reference when writing SQL or reasoning about table relationships.



Compare against:

\- `/migrations/` (source-of-truth migration files)

\- `SCHEMA\_NOTES.md` (curated gotchas + relationships)



Re-upload to Claude Project knowledge after each sprint phase that adds tables or columns.



\---



\## Schema dump



| table\_name         | column\_name               | data\_type                | is\_nullable | column\_default                 |

| ------------------ | ------------------------- | ------------------------ | ----------- | ------------------------------ |

| admin\_users        | user\_id                   | uuid                     | NO          | null                           |

| admin\_users        | added\_at                  | timestamp with time zone | NO          | now()                          |

| admin\_users        | notes                     | text                     | YES         | null                           |

| business\_assets    | id                        | uuid                     | NO          | gen\_random\_uuid()              |

| business\_assets    | business\_id               | uuid                     | NO          | null                           |

| business\_assets    | task\_run\_id               | uuid                     | YES         | null                           |

| business\_assets    | asset\_type                | text                     | NO          | null                           |

| business\_assets    | asset\_subtype             | text                     | YES         | null                           |

| business\_assets    | asset\_url                 | text                     | YES         | null                           |

| business\_assets    | asset\_text                | text                     | YES         | null                           |

| business\_assets    | asset\_data                | jsonb                    | YES         | null                           |

| business\_assets    | created\_at                | timestamp with time zone | NO          | now()                          |

| business\_assets    | updated\_at                | timestamp with time zone | NO          | now()                          |

| business\_assets    | metadata                  | jsonb                    | NO          | '{}'::jsonb                    |

| business\_context   | id                        | uuid                     | NO          | uuid\_generate\_v4()             |

| business\_context   | business\_id               | uuid                     | NO          | null                           |

| business\_context   | user\_id                   | uuid                     | NO          | null                           |

| business\_context   | user\_profile              | jsonb                    | NO          | '{}'::jsonb                    |

| business\_context   | user\_research\_log         | jsonb                    | NO          | '\[]'::jsonb                    |

| business\_context   | business\_summary          | text                     | YES         | null                           |

| business\_context   | industry                  | text                     | YES         | null                           |

| business\_context   | business\_model            | text                     | YES         | null                           |

| business\_context   | target\_customer           | jsonb                    | NO          | '{}'::jsonb                    |

| business\_context   | value\_proposition         | text                     | YES         | null                           |

| business\_context   | market\_size               | jsonb                    | NO          | '{}'::jsonb                    |

| business\_context   | competitors               | jsonb                    | NO          | '\[]'::jsonb                    |

| business\_context   | market\_trends             | jsonb                    | NO          | '\[]'::jsonb                    |

| business\_context   | positioning\_statement     | text                     | YES         | null                           |

| business\_context   | brand\_voice               | text                     | YES         | null                           |

| business\_context   | key\_differentiators       | jsonb                    | NO          | '\[]'::jsonb                    |

| business\_context   | financial\_snapshot        | jsonb                    | NO          | '{}'::jsonb                    |

| business\_context   | customer\_signals          | jsonb                    | NO          | '{}'::jsonb                    |

| business\_context   | open\_questions            | jsonb                    | NO          | '\[]'::jsonb                    |

| business\_context   | telegram\_chat\_id          | text                     | YES         | null                           |

| business\_context   | last\_research\_run\_at      | timestamp with time zone | YES         | null                           |

| business\_context   | research\_confidence\_score | integer                  | NO          | 0                              |

| business\_context   | created\_at                | timestamp with time zone | NO          | now()                          |

| business\_context   | updated\_at                | timestamp with time zone | NO          | now()                          |

| business\_context   | agent\_name                | text                     | YES         | null                           |

| businesses         | id                        | uuid                     | NO          | uuid\_generate\_v4()             |

| businesses         | user\_id                   | uuid                     | NO          | null                           |

| businesses         | slug                      | text                     | NO          | null                           |

| businesses         | name                      | text                     | NO          | null                           |

| businesses         | kind                      | USER-DEFINED             | NO          | null                           |

| businesses         | existing\_business\_url     | text                     | YES         | null                           |

| businesses         | existing\_business\_data    | jsonb                    | YES         | null                           |

| businesses         | created\_at                | timestamp with time zone | NO          | now()                          |

| email\_queue        | id                        | uuid                     | NO          | gen\_random\_uuid()              |

| email\_queue        | business\_id               | uuid                     | NO          | null                           |

| email\_queue        | user\_id                   | uuid                     | NO          | null                           |

| email\_queue        | task\_run\_id               | uuid                     | YES         | null                           |

| email\_queue        | to\_email                  | text                     | NO          | null                           |

| email\_queue        | to\_name                   | text                     | YES         | null                           |

| email\_queue        | to\_company                | text                     | YES         | null                           |

| email\_queue        | to\_role                   | text                     | YES         | null                           |

| email\_queue        | from\_email                | text                     | NO          | 'yourbusiness@textos.ai'::text |

| email\_queue        | subject                   | text                     | NO          | null                           |

| email\_queue        | body                      | text                     | NO          | null                           |

| email\_queue        | status                    | text                     | NO          | 'pending'::text                |

| email\_queue        | created\_at                | timestamp with time zone | NO          | now()                          |

| email\_queue        | approved\_at               | timestamp with time zone | YES         | null                           |

| email\_queue        | approved\_by               | uuid                     | YES         | null                           |

| email\_queue        | sent\_at                   | timestamp with time zone | YES         | null                           |

| email\_queue        | sendgrid\_message\_id       | text                     | YES         | null                           |

| email\_queue        | rejection\_reason          | text                     | YES         | null                           |

| email\_queue        | edited                    | boolean                  | NO          | false                          |

| email\_queue        | edited\_subject            | text                     | YES         | null                           |

| email\_queue        | edited\_body               | text                     | YES         | null                           |

| subscription\_plans | id                        | uuid                     | NO          | uuid\_generate\_v4()             |

| subscription\_plans | slug                      | text                     | NO          | null                           |

| subscription\_plans | name                      | text                     | NO          | null                           |

| subscription\_plans | monthly\_cents             | integer                  | NO          | null                           |

| subscription\_plans | one\_time\_cents            | integer                  | NO          | 0                              |

| subscription\_plans | business\_quota            | integer                  | NO          | 1                              |

| subscription\_plans | includes\_premium\_tasks    | boolean                  | NO          | false                          |

| subscription\_plans | is\_grandfathered          | boolean                  | NO          | false                          |

| subscription\_plans | cohort\_limit              | integer                  | YES         | null                           |

| subscription\_plans | is\_active                 | boolean                  | NO          | true                           |

| subscription\_plans | created\_at                | timestamp with time zone | NO          | now()                          |

| task\_purchases     | id                        | uuid                     | NO          | uuid\_generate\_v4()             |

| task\_purchases     | user\_id                   | uuid                     | NO          | null                           |

| task\_purchases     | task\_id                   | uuid                     | NO          | null                           |

| task\_purchases     | business\_id               | uuid                     | YES         | null                           |

| task\_purchases     | amount\_cents              | integer                  | NO          | null                           |

| task\_purchases     | stripe\_payment\_intent     | text                     | YES         | null                           |

| task\_purchases     | created\_at                | timestamp with time zone | NO          | now()                          |

| task\_runs          | id                        | uuid                     | NO          | uuid\_generate\_v4()             |

| task\_runs          | user\_id                   | uuid                     | NO          | null                           |

| task\_runs          | business\_id               | uuid                     | YES         | null                           |

| task\_runs          | task\_id                   | uuid                     | NO          | null                           |

| task\_runs          | status                    | USER-DEFINED             | NO          | 'queued'::task\_run\_status      |

| task\_runs          | started\_at                | timestamp with time zone | NO          | now()                          |

| task\_runs          | completed\_at              | timestamp with time zone | YES         | null                           |

| task\_runs          | output\_data               | jsonb                    | YES         | null                           |

| task\_runs          | paid\_amount\_cents         | integer                  | NO          | 0                              |

| task\_runs          | error                     | text                     | YES         | null                           |

| task\_runs          | state                     | USER-DEFINED             | NO          | 'proposed'::task\_state         |

| task\_runs          | proposed\_at               | timestamp with time zone | YES         | now()                          |

| task\_runs          | failed\_at                 | timestamp with time zone | YES         | null                           |

| task\_runs          | work\_log                  | jsonb                    | NO          | '\[]'::jsonb                    |

