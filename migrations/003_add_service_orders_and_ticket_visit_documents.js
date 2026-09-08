module.exports = {
  id: '003_add_service_orders_and_ticket_visit_documents',
  up: `
ALTER TABLE companies ADD COLUMN auto_create_visit_from_ticket INTEGER NOT NULL DEFAULT 0 CHECK (auto_create_visit_from_ticket IN (0,1));

CREATE TABLE service_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE CHECK (length(trim(order_number)) > 0),
  ticket_id INTEGER NOT NULL,
  service_mode TEXT NOT NULL CHECK (service_mode IN ('remote','onsite')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','in_progress','completed','cancelled')),
  assigned_technician_id INTEGER,
  description TEXT,
  created_by_user_id INTEGER NOT NULL,
  started_at DATETIME,
  completed_at DATETIME,
  cancelled_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (assigned_technician_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_service_orders_ticket ON service_orders(ticket_id);
CREATE INDEX idx_service_orders_technician ON service_orders(assigned_technician_id);
CREATE INDEX idx_service_orders_status ON service_orders(status);

PRAGMA defer_foreign_keys = ON;

CREATE TABLE technical_visits_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  visit_number TEXT NOT NULL UNIQUE CHECK (length(trim(visit_number)) > 0),
  company_id INTEGER NOT NULL,
  unit_id INTEGER,
  technician_user_id INTEGER,
  ticket_id INTEGER,
  service_order_id INTEGER,
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
  FOREIGN KEY (service_order_id) REFERENCES service_orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
);

INSERT INTO technical_visits_new (
  id,visit_number,company_id,unit_id,technician_user_id,ticket_id,visit_type,status,
  scheduled_at,general_notes,started_at,finished_at,validated_at,cancelled_at,
  created_by_user_id,created_at,updated_at
)
SELECT
  id,visit_number,company_id,unit_id,technician_user_id,ticket_id,visit_type,status,
  scheduled_at,general_notes,started_at,finished_at,validated_at,cancelled_at,
  created_by_user_id,created_at,updated_at
FROM technical_visits;

DROP TABLE technical_visits;
ALTER TABLE technical_visits_new RENAME TO technical_visits;

CREATE INDEX idx_technical_visits_company ON technical_visits(company_id);
CREATE INDEX idx_technical_visits_technician ON technical_visits(technician_user_id);
CREATE INDEX idx_technical_visits_status ON technical_visits(status);
CREATE INDEX idx_technical_visits_scheduled_at ON technical_visits(scheduled_at);
CREATE INDEX idx_technical_visits_ticket ON technical_visits(ticket_id);
CREATE INDEX idx_technical_visits_service_order ON technical_visits(service_order_id);

CREATE TABLE ticket_visit_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  visit_document_id INTEGER NOT NULL,
  attached_by_user_id INTEGER,
  attached_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ticket_id,visit_document_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (visit_document_id) REFERENCES visit_documents(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  FOREIGN KEY (attached_by_user_id) REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT
);
CREATE INDEX idx_ticket_visit_documents_ticket ON ticket_visit_documents(ticket_id);
CREATE INDEX idx_ticket_visit_documents_document ON ticket_visit_documents(visit_document_id);
`
};
