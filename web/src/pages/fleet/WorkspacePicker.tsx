import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  ChevronUp,
  Folder,
  FolderOpen,
  HardDrive,
  Search,
} from "lucide-react";
import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import {
  listWorkspaceDirectories,
  type DirectoryListing,
} from "@/api/hostResources";

type Directory = DirectoryListing["directories"][number];
const MAX_VISIBLE_COLUMNS = 3;

function folderName(path: string | null) {
  if (path === null) return "Locations";
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? path;
}

function DirectoryColumn({
  active,
  open,
  path,
  search,
  selectedPath,
  onSelect,
}: {
  active: boolean;
  open: boolean;
  path: string | null;
  search: string;
  selectedPath: string | null;
  onSelect: (directory: Directory) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const listing = useQuery({
    queryKey: ["workspace-directories", path],
    queryFn: () => listWorkspaceDirectories(path),
    enabled: open,
  });
  const directories = listing.data?.directories ?? [];
  const filteredDirectories = useMemo(() => {
    const needle = active ? search.trim().toLowerCase() : "";
    if (!needle) return directories;
    return directories.filter(
      (directory) =>
        directory.name.toLowerCase().includes(needle) ||
        directory.path.toLowerCase().includes(needle),
    );
  }, [active, directories, search]);
  const virtualizer = useVirtualizer({
    count: filteredDirectories.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 36,
    overscan: 8,
    initialRect: { width: 256, height: 304 },
  });

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0 });
  }, [search]);

  return (
    <Box
      aria-label={`Folders in ${path ?? "available locations"}`}
      data-workspace-column
      data-workspace-column-active={active || undefined}
      role="group"
    >
      <Group data-workspace-column-heading gap="xs" wrap="nowrap">
        {path === null ? (
          <HardDrive aria-hidden size={15} />
        ) : (
          <FolderOpen aria-hidden size={15} />
        )}
        <Text fw={600} size="xs" title={path ?? undefined} truncate>
          {folderName(path)}
        </Text>
      </Group>

      {listing.isPending ? (
        <Center data-workspace-picker-loading h="100%">
          <Stack align="center" gap="xs">
            <Loader size="sm" />
            <Text c="dimmed" size="xs">Loading folders…</Text>
          </Stack>
        </Center>
      ) : null}
      {listing.isError ? (
        <Alert color="danger" m="xs" title="Folder listing unavailable" variant="light">
          {(listing.error as Error).message}
        </Alert>
      ) : null}
      {listing.data ? (
        <Box
          aria-label={`Folders in ${path ?? "available locations"}`}
          data-workspace-option-viewport
          ref={viewportRef}
          role="listbox"
        >
          {filteredDirectories.length === 0 ? (
            <Center data-workspace-column-empty h="100%" px="md">
              <Stack align="center" gap={4}>
                <Folder aria-hidden color="var(--mantine-color-neutral-5)" size={24} />
                <Text c="dimmed" size="xs" ta="center">
                  {directories.length === 0
                    ? "No folders inside"
                    : "No folders match this search"}
                </Text>
              </Stack>
            </Center>
          ) : (
            <Box style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const directory = filteredDirectories[virtualItem.index];
                const selected = directory.path === selectedPath;
                return (
                  <UnstyledButton
                    aria-selected={selected}
                    data-workspace-folder-option
                    data-selected={selected || undefined}
                    key={directory.path}
                    onClick={() => onSelect(directory)}
                    role="option"
                    style={{
                      height: virtualItem.size,
                      left: 0,
                      position: "absolute",
                      top: 0,
                      transform: `translateY(${virtualItem.start}px)`,
                      width: "100%",
                    }}
                  >
                    <Group gap="xs" h="100%" px="sm" wrap="nowrap">
                      <Folder aria-hidden size={15} />
                      <Text ff="monospace" size="xs" truncate style={{ flex: 1 }}>
                        {directory.name}
                      </Text>
                      <ChevronRight aria-hidden data-workspace-folder-chevron size={14} />
                    </Group>
                  </UnstyledButton>
                );
              })}
            </Box>
          )}
        </Box>
      ) : null}
      {listing.data?.truncated ? (
        <Text c="dimmed" data-workspace-picker-truncated px="sm" py={6} size="xs">
          Showing the first 500 child folders returned by the server.
        </Text>
      ) : null}
    </Box>
  );
}

export function WorkspacePicker({
  id,
  value,
  onChange,
  onOpenChange,
}: {
  id: string;
  value: string;
  onChange: (path: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [columnPaths, setColumnPaths] = useState<Array<string | null>>([null]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const columnStripRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedListing = useQuery({
    queryKey: ["workspace-directories", selectedPath],
    queryFn: () => listWorkspaceDirectories(selectedPath),
    enabled: open,
  });

  useEffect(() => {
    if (!searchOpen) return;
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    requestAnimationFrame(() => {
      columnStripRef.current?.scrollTo({
        behavior: "auto",
        left: columnStripRef.current.scrollWidth,
      });
    });
  }, [columnPaths]);

  const navigateTo = (directory: Directory, columnIndex: number) => {
    setColumnPaths((current) =>
      [...current.slice(0, columnIndex + 1), directory.path].slice(
        -MAX_VISIBLE_COLUMNS,
      ),
    );
    setSelectedPath(directory.path);
    setSearch("");
  };
  const showRoots = () => {
    setColumnPaths([null]);
    setSelectedPath(null);
    setSearch("");
  };
  const navigateUp = () => {
    if (selectedPath === null || !selectedListing.data) return;
    const parent = selectedListing.data.parent;
    setColumnPaths([parent]);
    setSelectedPath(parent);
    setSearch("");
  };
  const closePicker = () => {
    onOpenChange?.(false);
    setOpen(false);
  };

  return (
    <>
      <Button
        id={id}
        type="button"
        variant="outline"
        justify="flex-start"
        leftSection={<Folder aria-hidden size={14} />}
        onClick={() => {
          const initialPath = value || null;
          setColumnPaths([initialPath]);
          setSelectedPath(initialPath);
          setSearch("");
          setSearchOpen(false);
          onOpenChange?.(true);
          setOpen(true);
        }}
      >
        <Text component="span" ff="monospace" truncate>
          {value || "Select a folder…"}
        </Text>
      </Button>
      <Modal
        opened={open}
        onClose={closePicker}
        closeOnEscape
        closeButtonProps={{ "aria-label": "Close workspace picker" }}
        title="Select workspace folder"
        centered
        size="xl"
        styles={{
          body: { display: "flex", flexDirection: "column", minHeight: 0 },
          content: { maxWidth: "calc(100vw - 2rem)" },
        }}
      >
        <Stack data-workspace-picker gap="sm">
          <Group data-workspace-picker-toolbar gap="xs" wrap="nowrap">
            <Button
              type="button"
              variant="default"
              size="compact-sm"
              disabled={selectedPath === null || selectedListing.isPending}
              leftSection={<ChevronUp aria-hidden size={14} />}
              onClick={navigateUp}
            >
              Up
            </Button>
            <Button
              type="button"
              variant="default"
              size="compact-sm"
              disabled={selectedPath === null}
              leftSection={<HardDrive aria-hidden size={14} />}
              onClick={showRoots}
            >
              Roots
            </Button>
            <Text
              data-workspace-picker-path
              ff="monospace"
              size="xs"
              title={selectedPath ?? undefined}
              truncate
            >
              {selectedPath ?? "Choose a folder"}
            </Text>
            <Button
              aria-pressed={searchOpen}
              type="button"
              variant={searchOpen ? "light" : "default"}
              size="compact-sm"
              leftSection={<Search aria-hidden size={14} />}
              onClick={() => setSearchOpen((current) => !current)}
            >
              Search child folders
            </Button>
          </Group>

          {searchOpen ? (
            <TextInput
              aria-label="Search child folders"
              data-autofocus
              leftSection={<Search aria-hidden size={14} />}
              onChange={(event) => setSearch(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                const activeDirectories = selectedListing.data?.directories ?? [];
                const needle = search.trim().toLowerCase();
                const firstMatch = activeDirectories.find(
                  (directory) =>
                    !needle ||
                    directory.name.toLowerCase().includes(needle) ||
                    directory.path.toLowerCase().includes(needle),
                );
                if (!firstMatch) return;
                event.preventDefault();
                navigateTo(firstMatch, columnPaths.length - 1);
              }}
              placeholder="Filter the rightmost column"
              ref={searchInputRef}
              value={search}
            />
          ) : null}

          <Box data-workspace-column-browser ref={columnStripRef}>
            {columnPaths.map((path, index) => (
              <DirectoryColumn
                active={index === columnPaths.length - 1}
                key={`${path ?? "roots"}-${index}`}
                open={open}
                path={path}
                search={search}
                selectedPath={columnPaths[index + 1] ?? null}
                onSelect={(directory) => navigateTo(directory, index)}
              />
            ))}
          </Box>

          <Group data-workspace-picker-selection gap="xs" wrap="nowrap">
            <FolderOpen aria-hidden size={16} />
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text c="dimmed" size="xs">Selected folder</Text>
              <Text ff="monospace" size="xs" truncate title={selectedPath ?? undefined}>
                {selectedPath ?? "None selected"}
              </Text>
            </Box>
          </Group>

          <Group justify="flex-end">
            <Button type="button" variant="subtle" onClick={closePicker}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="filled"
              disabled={selectedPath === null}
              onClick={() => {
                if (selectedPath === null) return;
                onChange(selectedPath);
                closePicker();
              }}
            >
              Use this folder
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
