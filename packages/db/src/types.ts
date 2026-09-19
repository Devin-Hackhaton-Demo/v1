// Kézzel karbantartott Database típus a supabase gen types formátumában.
// (A CLI generátor Dockert igényel, ami ezen a gépen nincs — ha később lesz,
// az `npm run db:types` felülírhatja ezt a fájlt.)
// Forrás: supabase/migrations/*.sql — sémaváltozásnál ezt is frissíteni kell!

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: {
          id: string;
          name: string;
          context_revision: number;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          context_revision?: number;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          context_revision?: number;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      memberships: {
        Row: {
          id: string;
          project_id: string;
          user_id: string;
          role: Database['public']['Enums']['membership_role'];
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id: string;
          role?: Database['public']['Enums']['membership_role'];
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          user_id?: string;
          role?: Database['public']['Enums']['membership_role'];
          created_at?: string;
        };
        Relationships: [];
      };
      artifacts: {
        Row: {
          id: string;
          project_id: string;
          run_id: string | null;
          file_name: string;
          mime_type: string;
          size_bytes: number;
          sha256: string;
          storage_path: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          run_id?: string | null;
          file_name: string;
          mime_type: string;
          size_bytes: number;
          sha256: string;
          storage_path: string;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          project_id?: string;
          run_id?: string | null;
          file_name?: string;
          mime_type?: string;
          size_bytes?: number;
          sha256?: string;
          storage_path?: string;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      context_entries: {
        Row: {
          id: string;
          project_id: string;
          revision: number;
          source_kind: Database['public']['Enums']['source_kind'];
          source_label: string;
          conversation_ref: string | null;
          occurred_at: string | null;
          coverage: Database['public']['Enums']['coverage_kind'];
          submitted_text: string | null;
          summary: string;
          full_text_artifact_id: string | null;
          content_hash: string;
          created_by: string;
          saved_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          revision?: number; // a trigger tölti ki, a beküldött értéket felülírja
          source_kind: Database['public']['Enums']['source_kind'];
          source_label: string;
          conversation_ref?: string | null;
          occurred_at?: string | null;
          coverage: Database['public']['Enums']['coverage_kind'];
          submitted_text?: string | null;
          summary: string;
          full_text_artifact_id?: string | null;
          content_hash: string;
          created_by?: string;
          saved_at?: string;
        };
        Update: never; // immutábilis (trigger tiltja)
        Relationships: [];
      };
      decisions: {
        Row: {
          id: string;
          project_id: string;
          context_entry_id: string;
          key: string;
          value: string | number | boolean;
          source_excerpt: string | null;
          supersedes_decision_ids: string[];
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          context_entry_id: string;
          key: string;
          value: string | number | boolean;
          source_excerpt?: string | null;
          supersedes_decision_ids?: string[];
          created_by?: string;
          created_at?: string;
        };
        Update: never; // immutábilis (trigger tiltja)
        Relationships: [];
      };
      tasks: {
        Row: {
          id: string;
          project_id: string;
          context_entry_id: string | null;
          title: string;
          kind: Database['public']['Enums']['task_kind'];
          required_decision_keys: string[];
          input_artifact_ids: string[];
          status: Database['public']['Enums']['task_status'];
          latest_run_id: string | null;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          context_entry_id?: string | null;
          title: string;
          kind?: Database['public']['Enums']['task_kind'];
          required_decision_keys?: string[];
          input_artifact_ids?: string[];
          status?: Database['public']['Enums']['task_status'];
          latest_run_id?: string | null;
          created_by?: string;
          created_at?: string;
        };
        Update: {
          status?: Database['public']['Enums']['task_status'];
          latest_run_id?: string | null;
        };
        Relationships: [];
      };
      connections: {
        Row: {
          id: string;
          project_id: string;
          kind: Database['public']['Enums']['connection_kind'];
          target_repo: string;
          secret_ref: string;
          allowed_presets: Database['public']['Enums']['task_kind'][];
          created_by: string | null;
          created_at: string;
          revoked_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          kind?: Database['public']['Enums']['connection_kind'];
          target_repo: string;
          secret_ref: string;
          allowed_presets?: Database['public']['Enums']['task_kind'][];
          created_by?: string | null;
          created_at?: string;
          revoked_at?: string | null;
        };
        Update: {
          target_repo?: string;
          secret_ref?: string;
          allowed_presets?: Database['public']['Enums']['task_kind'][];
          revoked_at?: string | null;
        };
        Relationships: [];
      };
      runs: {
        Row: {
          id: string;
          project_id: string;
          task_id: string;
          state: Database['public']['Enums']['run_state'];
          preset: Database['public']['Enums']['task_kind'];
          preset_version: string;
          validator_version: string;
          context_revision: number;
          context_entry_ids: string[];
          snapshot_hash: string | null;
          payload_hash: string | null;
          run_at: string | null;
          attempt: number;
          attempt_id: string | null;
          lease_token_hash: string | null;
          lease_expires_at: string | null;
          runner_last_seen_at: string | null;
          result_artifact_id: string | null;
          checks: Json | null;
          error_code: string | null;
          error_message: string | null;
          started_at: string | null;
          finished_at: string | null;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          task_id: string;
          state?: Database['public']['Enums']['run_state'];
          preset?: Database['public']['Enums']['task_kind'];
          preset_version?: string;
          validator_version?: string;
          context_revision: number;
          context_entry_ids?: string[];
          snapshot_hash?: string | null;
          payload_hash?: string | null;
          run_at?: string | null;
          attempt?: number;
          attempt_id?: string | null;
          lease_token_hash?: string | null;
          lease_expires_at?: string | null;
          runner_last_seen_at?: string | null;
          result_artifact_id?: string | null;
          checks?: Json | null;
          error_code?: string | null;
          error_message?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          created_by?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['runs']['Insert']>;
        Relationships: [];
      };
      external_actions: {
        Row: {
          id: string;
          project_id: string;
          kind: Database['public']['Enums']['action_kind'];
          run_id: string;
          artifact_id: string;
          connection_id: string;
          repo: string;
          title: string;
          body: string;
          payload_hash: string;
          state: Database['public']['Enums']['action_state'];
          external_id: string | null;
          external_url: string | null;
          verified_at: string | null;
          error_code: string | null;
          error_message: string | null;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          kind?: Database['public']['Enums']['action_kind'];
          run_id: string;
          artifact_id: string;
          connection_id: string;
          repo: string;
          title: string;
          body: string;
          payload_hash: string;
          state?: Database['public']['Enums']['action_state'];
          external_id?: string | null;
          external_url?: string | null;
          verified_at?: string | null;
          error_code?: string | null;
          error_message?: string | null;
          created_by?: string;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['external_actions']['Insert']>;
        Relationships: [];
      };
      approvals: {
        Row: {
          id: string;
          project_id: string;
          subject: Database['public']['Enums']['approval_subject'];
          run_id: string | null;
          action_id: string | null;
          payload_hash: string;
          run_at: string | null;
          approved_by: string;
          approved_at: string;
          expires_at: string;
          revoked_at: string | null;
          consumed_at: string | null;
        };
        Insert: {
          id?: string;
          project_id: string;
          subject: Database['public']['Enums']['approval_subject'];
          run_id?: string | null;
          action_id?: string | null;
          payload_hash: string;
          run_at?: string | null;
          approved_by?: string;
          approved_at?: string;
          expires_at: string;
          revoked_at?: string | null;
          consumed_at?: string | null;
        };
        Update: {
          revoked_at?: string | null;
          consumed_at?: string | null;
        };
        Relationships: [];
      };
      runner_identities: {
        Row: {
          id: string;
          project_id: string;
          name: string;
          token_hash: string;
          allowed_presets: Database['public']['Enums']['task_kind'][];
          last_seen_at: string | null;
          revoked_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          name: string;
          token_hash: string;
          allowed_presets?: Database['public']['Enums']['task_kind'][];
          last_seen_at?: string | null;
          revoked_at?: string | null;
          created_at?: string;
        };
        Update: Partial<Database['public']['Tables']['runner_identities']['Insert']>;
        Relationships: [];
      };
      audit_events: {
        Row: {
          id: string;
          project_id: string | null;
          actor_kind: 'user' | 'service' | 'runner';
          actor_id: string | null;
          action: string;
          target_kind: string | null;
          target_id: string | null;
          request_id: string | null;
          detail: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id?: string | null;
          actor_kind: 'user' | 'service' | 'runner';
          actor_id?: string | null;
          action: string;
          target_kind?: string | null;
          target_id?: string | null;
          request_id?: string | null;
          detail?: Json | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      idempotency_records: {
        Row: {
          id: string;
          project_id: string;
          actor_id: string;
          tool: string;
          idempotency_key: string;
          payload_fingerprint: string;
          result: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          actor_id: string;
          tool: string;
          idempotency_key: string;
          payload_fingerprint: string;
          result?: Json | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      user_connections: {
        Row: {
          id: string;
          user_id: string;
          provider: Database['public']['Enums']['provider_kind'];
          label: string;
          /** vault.secrets.id reference only — never the secret itself. */
          secret_ref: string | null;
          scopes: string[];
          /** Non-secret provider metadata only. */
          metadata: Json;
          created_at: string;
          updated_at: string;
          revoked_at: string | null;
        };
        // Writes go through the store/revoke RPCs (no insert/update RLS
        // policies); the Insert/Update shapes exist for the service role.
        Insert: {
          id?: string;
          user_id: string;
          provider: Database['public']['Enums']['provider_kind'];
          label?: string;
          secret_ref?: string | null;
          scopes?: string[];
          metadata?: Json;
          created_at?: string;
          updated_at?: string;
          revoked_at?: string | null;
        };
        Update: Partial<Database['public']['Tables']['user_connections']['Insert']>;
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      is_project_member: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      is_project_owner: {
        Args: { p_project_id: string };
        Returns: boolean;
      };
      save_context: {
        Args: {
          p_project_id: string;
          p_source: Json;
          p_coverage: Database['public']['Enums']['coverage_kind'];
          p_summary: string;
          p_content_hash: string;
          p_submitted_text?: string | null;
          p_full_text_artifact_id?: string | null;
          p_decisions?: Json;
          p_tasks?: Json;
        };
        Returns: Json;
      };
      prepare_run: {
        Args: {
          p_project_id: string;
          p_task_id: string;
          p_context_revision: number;
          p_context_entry_ids: string[];
          p_payload_hash: string;
          p_snapshot_hash?: string | null;
          p_run_at?: string | null;
        };
        Returns: Json;
      };
      activate_due_runs: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      claim_run: {
        Args: { p_preset?: Database['public']['Enums']['task_kind'] };
        Returns: Json;
      };
      heartbeat_run: {
        Args: {
          p_run_id: string;
          p_attempt_id: string;
          p_lease_token: string;
        };
        Returns: Json;
      };
      complete_run: {
        Args: {
          p_run_id: string;
          p_attempt_id: string;
          p_lease_token: string;
          p_result_key: string;
          p_payload_hash: string;
          p_artifact: Json;
          p_checks: Json;
        };
        Returns: Json;
      };
      fail_run: {
        Args: {
          p_run_id: string;
          p_attempt_id: string;
          p_lease_token: string;
          p_result_key: string;
          p_error_code: string;
          p_safe_message: string;
          p_retryable?: boolean;
        };
        Returns: Json;
      };
      store_user_connection: {
        Args: {
          p_provider: Database['public']['Enums']['provider_kind'];
          p_secret: string;
          p_label?: string;
          p_scopes?: string[];
          p_metadata?: Json;
        };
        Returns: Json;
      };
      revoke_user_connection: {
        Args: { p_connection_id: string };
        Returns: Json;
      };
      get_user_connection_secret: {
        Args: { p_connection_id: string };
        Returns: string;
      };
    };
    Enums: {
      membership_role: 'owner' | 'member';
      source_kind: 'chatgpt' | 'manual_import';
      coverage_kind: 'summary_only' | 'partial_text' | 'supplied_export';
      task_kind: 'draft_brief';
      task_status: 'open' | 'running' | 'done' | 'blocked';
      run_state:
        | 'awaiting_approval'
        | 'scheduled'
        | 'queued'
        | 'running'
        | 'succeeded'
        | 'failed'
        | 'cancelled'
        | 'blocked';
      action_state:
        | 'awaiting_approval'
        | 'queued'
        | 'executing'
        | 'succeeded'
        | 'failed'
        | 'outcome_unknown'
        | 'cancelled'
        | 'blocked';
      action_kind: 'github_issue_create';
      connection_kind: 'github';
      approval_subject: 'run' | 'external_action';
      provider_kind: 'google' | 'github' | 'vercel' | 'composio' | 'supabase' | 'notion';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type Enums<T extends keyof Database['public']['Enums']> =
  Database['public']['Enums'][T];
