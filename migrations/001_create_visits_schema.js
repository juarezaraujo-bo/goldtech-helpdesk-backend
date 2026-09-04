module.exports = {
  id: '001_create_visits_schema',
  up: `
CREATE TABLE company_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('primary_manager','substitute')),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  email TEXT NOT NULL CHECK (length(trim(email)) > 0),
  phone TEXT,
  job_title TEXT NOT NULL CHECK (length(trim(job_title)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_company_contacts_active_type ON company_contacts(company_id,contact_type) WHERE active=1;
CREATE INDEX idx_company_contacts_company ON company_contacts(company_id);
CREATE INDEX idx_company_contacts_email ON company_contacts(email);

CREATE TABLE company_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  address TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_company_units_active_name ON company_units(company_id,name COLLATE NOCASE) WHERE active=1;
CREATE INDEX idx_company_units_company ON company_units(company_id);

CREATE TABLE company_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  unit_id INTEGER,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  operational_contact_name TEXT,
  operational_contact_email TEXT,
  operational_contact_phone TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (unit_id) REFERENCES company_units(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_company_departments_without_unit ON company_departments(company_id,name COLLATE NOCASE) WHERE active=1 AND unit_id IS NULL;
CREATE UNIQUE INDEX uq_company_departments_with_unit ON company_departments(unit_id,name COLLATE NOCASE) WHERE active=1 AND unit_id IS NOT NULL;
CREATE INDEX idx_company_departments_company ON company_departments(company_id);
CREATE INDEX idx_company_departments_unit ON company_departments(unit_id);

CREATE TABLE technical_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_number TEXT NOT NULL UNIQUE CHECK (length(trim(visit_number)) > 0),
  company_id INTEGER NOT NULL,
  unit_id INTEGER,
  technician_user_id INTEGER NOT NULL,
  ticket_id INTEGER,
  visit_type TEXT NOT NULL CHECK (visit_type IN ('preventive','ticket','emergency','project')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','in_progress','awaiting_validation','validated','cancelled')),
  scheduled_at DATETIME,
  general_notes TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  validated_at DATETIME,
  cancelled_at DATETIME,
  created_by_user_id INTEGER NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (unit_id) REFERENCES company_units(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (technician_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_technical_visits_company ON technical_visits(company_id);
CREATE INDEX idx_technical_visits_technician ON technical_visits(technician_user_id);
CREATE INDEX idx_technical_visits_status ON technical_visits(status);
CREATE INDEX idx_technical_visits_scheduled_at ON technical_visits(scheduled_at);
CREATE INDEX idx_technical_visits_ticket ON technical_visits(ticket_id);

CREATE TABLE technical_visit_departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  department_id INTEGER NOT NULL,
  department_name_snapshot TEXT NOT NULL CHECK (length(trim(department_name_snapshot)) > 0),
  demand_status TEXT CHECK (demand_status IS NULL OR demand_status IN ('com_demanda','sem_demanda')),
  activities TEXT,
  notes TEXT,
  has_pending_issue INTEGER NOT NULL DEFAULT 0 CHECK (has_pending_issue IN (0,1)),
  requires_return INTEGER NOT NULL DEFAULT 0 CHECK (requires_return IN (0,1)),
  standardized_description TEXT,
  validation_required INTEGER NOT NULL DEFAULT 1 CHECK (validation_required IN (0,1)),
  validation_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (validation_status IN ('not_requested','pending','validated','expired','revoked')),
  selected_contact_id INTEGER,
  validator_name_snapshot TEXT,
  validator_email_snapshot TEXT,
  validator_phone_snapshot TEXT,
  validator_job_title_snapshot TEXT,
  started_at DATETIME,
  completed_at DATETIME,
  validation_requested_at DATETIME,
  validated_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (visit_id,department_id),
  FOREIGN KEY (visit_id) REFERENCES technical_visits(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (department_id) REFERENCES company_departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (selected_contact_id) REFERENCES company_contacts(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_visit_departments_visit ON technical_visit_departments(visit_id);
CREATE INDEX idx_visit_departments_department ON technical_visit_departments(department_id);
CREATE INDEX idx_visit_departments_validation_status ON technical_visit_departments(validation_status);

CREATE TABLE visit_validation_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_department_id INTEGER NOT NULL,
  contact_id INTEGER NOT NULL,
  contact_type_snapshot TEXT NOT NULL CHECK (contact_type_snapshot IN ('primary_manager','substitute')),
  recipient_name TEXT NOT NULL CHECK (length(trim(recipient_name)) > 0),
  recipient_email TEXT NOT NULL CHECK (length(trim(recipient_email)) > 0),
  recipient_job_title TEXT NOT NULL CHECK (length(trim(recipient_job_title)) > 0),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(trim(token_hash)) >= 32),
  token_hint TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created','sent','delivery_failed','validated','expired','revoked')),
  sent_at DATETIME,
  expires_at DATETIME NOT NULL,
  validated_at DATETIME,
  accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0,1)),
  validation_ip TEXT,
  validation_user_agent TEXT,
  protocol TEXT NOT NULL UNIQUE CHECK (length(trim(protocol)) > 0),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (visit_department_id) REFERENCES technical_visit_departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (contact_id) REFERENCES company_contacts(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_validation_requests_department ON visit_validation_requests(visit_department_id);
CREATE INDEX idx_validation_requests_contact ON visit_validation_requests(contact_id);
CREATE INDEX idx_validation_requests_status ON visit_validation_requests(status);
CREATE INDEX idx_validation_requests_expires_at ON visit_validation_requests(expires_at);

CREATE TABLE visit_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  document_type TEXT NOT NULL CHECK (length(trim(document_type)) > 0),
  storage_path TEXT NOT NULL CHECK (length(trim(storage_path)) > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256)=64),
  generated_at DATETIME NOT NULL,
  generated_by INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'generated' CHECK (status IN ('pending','generated','failed','archived')),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (visit_id,document_type,version),
  FOREIGN KEY (visit_id) REFERENCES technical_visits(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (generated_by) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_visit_documents_visit ON visit_documents(visit_id);
CREATE INDEX idx_visit_documents_sha256 ON visit_documents(sha256);

CREATE TABLE visit_document_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL,
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('validator','primary_manager','goldtech_archive')),
  recipient_name TEXT NOT NULL CHECK (length(trim(recipient_name)) > 0),
  recipient_email TEXT NOT NULL CHECK (length(trim(recipient_email)) > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  sent_at DATETIME,
  failed_at DATETIME,
  error_code TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (document_id,recipient_type,recipient_email),
  FOREIGN KEY (document_id) REFERENCES visit_documents(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_document_deliveries_document ON visit_document_deliveries(document_id);
CREATE INDEX idx_document_deliveries_status ON visit_document_deliveries(status);

CREATE TABLE visit_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_id INTEGER NOT NULL,
  visit_department_id INTEGER,
  actor_user_id INTEGER,
  actor_contact_id INTEGER,
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  user_agent TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  FOREIGN KEY (visit_id) REFERENCES technical_visits(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (visit_department_id) REFERENCES technical_visit_departments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (actor_contact_id) REFERENCES company_contacts(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_visit_audit_events_visit ON visit_audit_events(visit_id,occurred_at);
CREATE INDEX idx_visit_audit_events_department ON visit_audit_events(visit_department_id);
CREATE INDEX idx_visit_audit_events_type ON visit_audit_events(event_type);
`
};
