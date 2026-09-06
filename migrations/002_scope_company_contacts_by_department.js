module.exports = {
  id: '002_scope_company_contacts_by_department',
  up: `
ALTER TABLE company_contacts ADD COLUMN department_id INTEGER REFERENCES company_departments(id) ON UPDATE CASCADE ON DELETE RESTRICT;

DROP INDEX IF EXISTS uq_company_contacts_active_type;
CREATE UNIQUE INDEX IF NOT EXISTS uq_company_contacts_active_department_type
  ON company_contacts(company_id,department_id,contact_type)
  WHERE active=1 AND department_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_contacts_department ON company_contacts(department_id);

CREATE TRIGGER IF NOT EXISTS trg_company_contacts_department_company_insert
BEFORE INSERT ON company_contacts
WHEN NEW.department_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM company_departments
    WHERE id=NEW.department_id AND company_id=NEW.company_id
  )
BEGIN
  SELECT RAISE(ABORT, 'contact department must belong to company');
END;

CREATE TRIGGER IF NOT EXISTS trg_company_contacts_department_company_update
BEFORE UPDATE OF company_id,department_id ON company_contacts
WHEN NEW.department_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM company_departments
    WHERE id=NEW.department_id AND company_id=NEW.company_id
  )
BEGIN
  SELECT RAISE(ABORT, 'contact department must belong to company');
END;
`
};
