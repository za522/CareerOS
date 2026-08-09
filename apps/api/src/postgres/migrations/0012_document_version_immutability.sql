CREATE OR REPLACE FUNCTION careeros.protect_document_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document versions are immutable';
  END IF;

  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.document_id IS DISTINCT FROM OLD.document_id
    OR NEW.job_posting_id IS DISTINCT FROM OLD.job_posting_id
    OR NEW.parent_version_id IS DISTINCT FROM OLD.parent_version_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.checkpoint_name IS DISTINCT FROM OLD.checkpoint_name
    OR NEW.content_json IS DISTINCT FROM OLD.content_json
    OR NEW.plain_text IS DISTINCT FROM OLD.plain_text
    OR NEW.accepted_change_ids IS DISTINCT FROM OLD.accepted_change_ids
    OR NEW.proposal_changes IS DISTINCT FROM OLD.proposal_changes
    OR NEW.proposal_decisions IS DISTINCT FROM OLD.proposal_decisions
    OR NEW.change_summary IS DISTINCT FROM OLD.change_summary
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.model IS DISTINCT FROM OLD.model
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'Document version content is immutable';
  END IF;

  IF NEW.relative_path IS DISTINCT FROM OLD.relative_path OR NEW.checksum IS DISTINCT FROM OLD.checksum THEN
    IF OLD.relative_path <> '' OR OLD.checksum <> '' THEN
      RAISE EXCEPTION 'Document version PDF is already finalised';
    END IF;
    IF NEW.relative_path = '' OR NEW.checksum = '' THEN
      RAISE EXCEPTION 'Document version PDF path and checksum must be finalised together';
    END IF;
  END IF;
  IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'Document version submission is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_versions_immutable ON document_versions;
CREATE TRIGGER document_versions_immutable
BEFORE UPDATE OR DELETE ON document_versions
FOR EACH ROW EXECUTE FUNCTION careeros.protect_document_version();
