import { useMutation } from "@tanstack/react-query";
import { CircleX, Copy, Pencil, Save, RefreshCw } from "lucide-react";
import {
  Form,
  useDataProvider,
  useGetIdentity,
  useGetOne,
  useNotify,
  useRecordContext,
} from "ra-core";
import { useState } from "react";
import { useFormState } from "react-hook-form";
import { RecordField } from "@/components/admin/record-field";
import { TextInput } from "@/components/admin/text-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import ImageEditorField from "../misc/ImageEditorField";
import type { CrmDataProvider } from "../providers/types";
import type { Sale, SalesFormData } from "../types";

export const SettingsPage = () => {
  const [isEditMode, setEditMode] = useState(false);
  const { identity, refetch: refetchIdentity } = useGetIdentity();
  const { data, refetch: refetchUser } = useGetOne("sales", {
    id: identity?.id,
  });
  const notify = useNotify();
  const dataProvider = useDataProvider<CrmDataProvider>();

  const { mutate } = useMutation({
    mutationKey: ["signup"],
    mutationFn: async (data: SalesFormData) => {
      if (!identity) {
        throw new Error("Record not found");
      }
      return dataProvider.salesUpdate(identity.id, data);
    },
    onSuccess: () => {
      refetchIdentity();
      refetchUser();
      setEditMode(false);
      notify("Your profile has been updated");
    },
    onError: (_) => {
      notify("An error occurred. Please try again", {
        type: "error",
      });
    },
  });

  if (!identity) return null;

  const handleOnSubmit = async (values: any) => {
    mutate(values);
  };

  return (
    <div className="max-w-lg mx-auto mt-8">
      <Form onSubmit={handleOnSubmit} record={data}>
        <SettingsForm isEditMode={isEditMode} setEditMode={setEditMode} />
      </Form>
    </div>
  );
};

const SettingsForm = ({
  isEditMode,
  setEditMode,
}: {
  isEditMode: boolean;
  setEditMode: (value: boolean) => void;
}) => {
  const notify = useNotify();
  const record = useRecordContext<Sale>();
  const { identity, refetch } = useGetIdentity();
  const { isDirty } = useFormState();
  const dataProvider = useDataProvider<CrmDataProvider>();

  const { mutate: updatePassword } = useMutation({
    mutationKey: ["updatePassword"],
    mutationFn: async () => {
      if (!identity) {
        throw new Error("Record not found");
      }
      return dataProvider.updatePassword(identity.id);
    },
    onSuccess: () => {
      notify("A reset password email has been sent to your email address");
    },
    onError: (e) => {
      notify(`${e}`, {
        type: "error",
      });
    },
  });

  const { mutate: mutateSale } = useMutation({
    mutationKey: ["signup"],
    mutationFn: async (data: SalesFormData) => {
      if (!record) {
        throw new Error("Record not found");
      }
      return dataProvider.salesUpdate(record.id, data);
    },
    onSuccess: () => {
      refetch();
      notify("Your profile has been updated");
    },
    onError: () => {
      notify("An error occurred. Please try again.");
    },
  });
  if (!identity) return null;

  const handleClickOpenPasswordChange = () => {
    updatePassword();
  };

  const handleAvatarUpdate = async (values: any) => {
    mutateSale(values);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent>
          <div className="mb-4 flex flex-row justify-between">
            <h2 className="text-xl font-semibold text-muted-foreground">
              My info
            </h2>
          </div>

          <div className="space-y-4 mb-4">
            <ImageEditorField
              source="avatar"
              type="avatar"
              onSave={handleAvatarUpdate}
              linkPosition="right"
            />
            <TextRender source="first_name" isEditMode={isEditMode} />
            <TextRender source="last_name" isEditMode={isEditMode} />
            <TextRender source="email" isEditMode={isEditMode} />
          </div>

          <div className="flex flex-row justify-end gap-2">
            {!isEditMode && (
              <>
                <Button
                  variant="outline"
                  type="button"
                  onClick={handleClickOpenPasswordChange}
                >
                  Change password
                </Button>
              </>
            )}

            <Button
              type="button"
              variant={isEditMode ? "ghost" : "outline"}
              onClick={() => setEditMode(!isEditMode)}
              className="flex items-center"
            >
              {isEditMode ? <CircleX /> : <Pencil />}
              {isEditMode ? "Cancel" : "Edit"}
            </Button>

            {isEditMode && (
              <Button type="submit" disabled={!isDirty} variant="outline">
                <Save />
                Save
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      {import.meta.env.VITE_INBOUND_EMAIL && (
        <Card>
          <CardContent>
            <div className="space-y-4 justify-between">
              <h2 className="text-xl font-semibold text-muted-foreground">
                Inbound email
              </h2>
              <p className="text-sm text-muted-foreground">
                You can start sending emails to your server's inbound email
                address, e.g. by adding it to the
                <b> Cc: </b> field. Atomic CRM will process the emails and add
                notes to the corresponding contacts.
              </p>
              <CopyPaste />
            </div>
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent>
          <div className="space-y-4 justify-between">
            <h2 className="text-xl font-semibold text-muted-foreground">
              Email Sync
            </h2>
            <p className="text-sm text-muted-foreground">
              Sync emails from your IMAP inbox. This will fetch unread emails
              and add them as notes to contacts.
            </p>
            <EmailSyncButton />
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

const TextRender = ({
  source,
  isEditMode,
}: {
  source: string;
  isEditMode: boolean;
}) => {
  if (isEditMode) {
    return <TextInput source={source} helperText={false} />;
  }
  return (
    <div className="m-2">
      <RecordField source={source} />
    </div>
  );
};

const CopyPaste = () => {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    setCopied(true);
    navigator.clipboard.writeText(import.meta.env.VITE_INBOUND_EMAIL);
    setTimeout(() => {
      setCopied(false);
    }, 1500);
  };
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={handleCopy}
            variant="ghost"
            className="normal-case justify-between w-full"
          >
            <span className="overflow-hidden text-ellipsis">
              {import.meta.env.VITE_INBOUND_EMAIL}
            </span>
            <Copy className="h-4 w-4 ml-2" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{copied ? "Copied!" : "Copy"}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const EmailSyncButton = () => {
  const [isSyncing, setIsSyncing] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null);
  const notify = useNotify();
  const dataProvider = useDataProvider<CrmDataProvider>();

  const syncBatch = async (mode: "full" | "incremental", offset?: number): Promise<{ processed: number; hasMore: boolean; nextOffset?: number; errors: number }> => {
    const data = await dataProvider.syncEmails(mode, offset);
    const processed = data?.processed?.length || 0;
    const errors = data?.errors?.length || 0;
    
    return {
      processed,
      hasMore: data?.hasMore || false,
      nextOffset: data?.nextOffset,
      errors,
    };
  };

  const handleSync = async () => {
    setIsSyncing(true);
    setProgress({ processed: 0, total: 0 });
    
    let totalProcessed = 0;
    let totalErrors = 0;
    let offset: number | undefined = undefined;
    let hasMore = true;
    let batchNumber = 0;

    try {
      // Manual sync: process ALL emails in batches
      while (hasMore) {
        batchNumber++;
        console.log(`Processing batch ${batchNumber}...`);
        
        const result = await syncBatch("full", offset);
        totalProcessed += result.processed;
        totalErrors += result.errors;
        hasMore = result.hasMore;
        offset = result.nextOffset;
        
        setProgress({ 
          processed: totalProcessed, 
          total: totalProcessed + (hasMore ? 1000 : 0) // Estimate if we don't know total
        });

        // Small delay between batches to avoid overwhelming the server
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      if (totalErrors > 0) {
        notify(
          `Synced ${totalProcessed} emails with ${totalErrors} errors. Check console for details.`,
          { type: "warning" },
        );
      } else {
        notify(`Successfully synced ${totalProcessed} emails`, { type: "success" });
      }
    } catch (error) {
      notify(`Failed to sync emails: ${error instanceof Error ? error.message : String(error)}`, {
        type: "error",
      });
    } finally {
      setIsSyncing(false);
      setProgress(null);
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        onClick={handleSync}
        disabled={isSyncing}
        variant="outline"
        className="w-full"
      >
        <RefreshCw className={`h-4 w-4 mr-2 ${isSyncing ? "animate-spin" : ""}`} />
        {isSyncing ? "Syncing..." : "Sync All Emails"}
      </Button>
      {progress && (
        <p className="text-sm text-muted-foreground text-center">
          Processed: {progress.processed} emails
        </p>
      )}
    </div>
  );
};

SettingsPage.path = "/settings";
