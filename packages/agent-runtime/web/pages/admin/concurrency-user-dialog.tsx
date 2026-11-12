import { Button } from "@fenix/ui-components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@fenix/ui-components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { useRequest } from "ahooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { agentConcurrencyApi, type UserConcurrencyPolicy } from "../../api/agent-concurrency";
import { AGENT_CONCURRENCY_NS } from "../../i18n/namespace";

/** 用户选择及并发编辑；搜索请求由 useRequest 隔离过期响应。 */
export function ConcurrencyUserDialog({
  initialUser,
  users,
  defaultValue,
  busy,
  error,
  onClose,
  onSave,
  onAuthFailure,
}: {
  initialUser?: UserConcurrencyPolicy;
  users: UserConcurrencyPolicy[];
  defaultValue: number | null;
  busy: boolean;
  error: string;
  onClose: () => void;
  onSave: (id: string, value: number) => Promise<void>;
  onAuthFailure: (error: Error) => void;
}) {
  const { t } = useTranslation(AGENT_CONCURRENCY_NS);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState(
    initialUser ? { id: initialUser.userId, name: initialUser.name, email: "" } : undefined,
  );
  const [limit, setLimit] = useState(
    (initialUser?.policy.userAgentMaxConcurrency.value ?? defaultValue)?.toString() ?? "",
  );
  const search = useRequest(() => agentConcurrencyApi.searchUsers(keyword), {
    refreshDeps: [keyword],
    debounceWait: 250,
    ready: !selected,
    onError: onAuthFailure,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t(initialUser ? "editUserTitle" : "users")}</DialogTitle>
          <DialogDescription>{t("usersHelp")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            const value = Number(limit);
            if (selected && Number.isInteger(value) && value > 0 && value <= 2147483647)
              void onSave(selected.id, value);
          }}
        >
          <div>
            <p className="mb-2 text-sm font-medium">{t("user")}</p>
            {selected ? (
              <div className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{selected.name}</p>
                  {selected.email && <p className="break-all text-xs text-muted-foreground">{selected.email}</p>}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setSelected(undefined);
                    setKeyword("");
                  }}
                >
                  {t("changeUser")}
                </Button>
              </div>
            ) : (
              <Command shouldFilter={false} className="rounded-md border">
                <CommandInput
                  id="concurrency-user-search"
                  aria-label={t("userSearch")}
                  placeholder={t("userSearch")}
                  value={keyword}
                  onValueChange={setKeyword}
                  maxLength={200}
                />
                <CommandList aria-label={t("user")}>
                  {search.loading ? (
                    <p role="status" className="p-4 text-sm text-muted-foreground">
                      {t("loading")}
                    </p>
                  ) : search.error ? (
                    <div role="alert" className="p-3 text-sm text-destructive">
                      <p>{search.error.message}</p>
                      <Button type="button" variant="outline" onClick={search.refresh}>
                        {t("retry")}
                      </Button>
                    </div>
                  ) : (
                    <>
                      <CommandEmpty>{t("noUsers")}</CommandEmpty>
                      {search.data?.map((user) => (
                        <CommandItem
                          key={user.id}
                          value={user.id}
                          onSelect={() => {
                            setSelected(user);
                            setLimit(
                              (
                                users.find((item) => item.userId === user.id)?.policy.userAgentMaxConcurrency.value ??
                                defaultValue
                              )?.toString() ?? "",
                            );
                          }}
                        >
                          <div>
                            <p>{user.name}</p>
                            <p className="text-xs text-muted-foreground">{user.email}</p>
                          </div>
                        </CommandItem>
                      ))}
                    </>
                  )}
                </CommandList>
                <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t("searchHelp")}</p>
              </Command>
            )}
          </div>
          <label htmlFor="concurrency-user-limit" className="block text-sm font-medium">
            {t("userLimit")}
            <Input
              id="concurrency-user-limit"
              className="mt-2"
              type="number"
              min={1}
              max={2147483647}
              step={1}
              required
              disabled={busy}
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {t("userDefault", {
              value: defaultValue === null ? t("unlimited") : t("limitValue", { count: defaultValue }),
            })}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy || !selected}>
              {t("saveUser")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
