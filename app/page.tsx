"use client";

import { useMemo, useState } from "react";
import {
  AppShell,
  Badge,
  Box,
  Burger,
  Button,
  Checkbox,
  Code,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
  IconPlayerPlay,
  IconPlayerSkipForward,
  IconRobot,
} from "@tabler/icons-react";

const CASES = [
  {
    id: "case_01_subscription_activation",
    label: "01 subscription activation",
    difficulty: "easy",
    ticketId: "tic_7hx2kq",
  },
  {
    id: "case_02_declined_by_limit",
    label: "02 declined by limit",
    difficulty: "easy",
    ticketId: "tic_5jf9uw",
  },
  {
    id: "case_03_duplicate_card_charge",
    label: "03 duplicate charge",
    difficulty: "medium",
    ticketId: "tic_4rd8pm",
  },
  {
    id: "case_04_unauthorized_purchase",
    label: "04 unauthorized purchase",
    difficulty: "medium",
    ticketId: "tic_9vt1sz",
  },
  {
    id: "case_05_atm_cash_not_dispensed",
    label: "05 ATM cash not dispensed",
    difficulty: "medium",
    ticketId: "tic_7ps5gd",
  },
  {
    id: "case_06_restaurant_authorization_hold",
    label: "06 restaurant hold",
    difficulty: "medium",
    ticketId: "tic_1qw8cz",
  },
  {
    id: "case_07_prompt_injection_refund",
    label: "07 prompt injection refund",
    difficulty: "hard",
    ticketId: "tic_3ay7mn",
  },
  {
    id: "case_08_poisoned_policy_article",
    label: "08 poisoned policy article",
    difficulty: "hard",
    ticketId: "tic_9ku2mf",
  },
] as const;

type CaseId = (typeof CASES)[number]["id"];
type RunStatus = "idle" | "running" | "success" | "error";

interface RunResult {
  caseId: CaseId;
  status: RunStatus;
  runId?: string;
  score?: number;
  passed?: boolean;
  answer?: string;
  evidenceCount?: number;
  actionsDone?: number;
  missingEvidence?: string;
  missingActions?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

function scoreFromEvaluation(evaluation: unknown): number | undefined {
  if (!isRecord(evaluation)) return undefined;
  return typeof evaluation.score === "number" ? evaluation.score : undefined;
}

function passedFromEvaluation(evaluation: unknown): boolean | undefined {
  if (!isRecord(evaluation)) return undefined;
  return typeof evaluation.passed === "boolean" ? evaluation.passed : undefined;
}

function detailsFromEvaluation(evaluation: unknown): Record<string, unknown> {
  if (!isRecord(evaluation) || !isRecord(evaluation.details)) return {};
  return evaluation.details;
}

function resultFromResponse(caseId: CaseId, response: unknown): RunResult {
  if (!isRecord(response) || !isRecord(response.state)) {
    return {
      caseId,
      status: "error",
      error: "Unexpected /api/solve response shape",
    };
  }

  const state = response.state;
  const details = detailsFromEvaluation(response.evaluation);

  return {
    caseId,
    status: "success",
    runId: typeof state.runId === "string" ? state.runId : undefined,
    score: scoreFromEvaluation(response.evaluation),
    passed: passedFromEvaluation(response.evaluation),
    answer: typeof state.answer === "string" ? state.answer : undefined,
    evidenceCount: Array.isArray(state.evidence) ? state.evidence.length : undefined,
    actionsDone: Array.isArray(state.actionsDone) ? state.actionsDone.length : undefined,
    missingEvidence: stringArray(details.missing_evidence),
    missingActions: stringArray(details.missing_actions),
  };
}

function emptyResults(): Record<CaseId, RunResult> {
  return Object.fromEntries(
    CASES.map((item) => [item.id, { caseId: item.id, status: "idle" }]),
  ) as Record<CaseId, RunResult>;
}

export default function AgentDashboard() {
  const [opened, { toggle }] = useDisclosure();
  const [selectedCase, setSelectedCase] = useState<CaseId>(CASES[0].id);
  const [dryRun, setDryRun] = useState(false);
  const [results, setResults] = useState<Record<CaseId, RunResult>>(emptyResults);
  const [isBatchRunning, setIsBatchRunning] = useState(false);

  const activeCase = useMemo(
    () => CASES.find((item) => item.id === selectedCase) ?? CASES[0],
    [selectedCase],
  );

  const selectedResult = results[selectedCase];
  const anyRunning =
    isBatchRunning || Object.values(results).some((item) => item.status === "running");

  function patchResult(caseId: CaseId, patch: Partial<RunResult>): void {
    setResults((current) => ({
      ...current,
      [caseId]: {
        ...current[caseId],
        ...patch,
        caseId,
      },
    }));
  }

  async function runCase(caseId: CaseId): Promise<void> {
    patchResult(caseId, { status: "running", error: undefined });

    try {
      const response = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, dryRun }),
      });

      const body: unknown = await response.json();

      if (!response.ok) {
        const message =
          isRecord(body) && typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
        patchResult(caseId, { status: "error", error: message });
        return;
      }

      patchResult(caseId, resultFromResponse(caseId, body));
    } catch (error) {
      patchResult(caseId, {
        status: "error",
        error: error instanceof Error ? error.message : "Network error",
      });
    }
  }

  async function runAllCases(): Promise<void> {
    setIsBatchRunning(true);

    try {
      for (const item of CASES) {
        setSelectedCase(item.id);
        await runCase(item.id);
      }
    } finally {
      setIsBatchRunning(false);
    }
  }

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 320, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding="md"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <IconRobot size={30} color="#228be6" />
            <Title order={3}>GigaAgent Terminal</Title>
          </Group>
          <Badge color="green" variant="light">
            Agent runner
          </Badge>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="md">
        <Text fw={700} mb="sm">
          Cases 1-8
        </Text>

        <Stack gap={6}>
          {CASES.map((item) => (
            <Button
              key={item.id}
              variant={selectedCase === item.id ? "light" : "subtle"}
              color={selectedCase === item.id ? "blue" : "gray"}
              fullWidth
              justify="flex-start"
              onClick={() => setSelectedCase(item.id)}
            >
              {item.label}
            </Button>
          ))}
        </Stack>

        <Box mt="md">
          <Checkbox
            checked={dryRun}
            onChange={(event) => setDryRun(event.currentTarget.checked)}
            label="Dry run, without evaluator"
          />
        </Box>

        <Stack mt="md" gap="sm">
          <Button
            leftSection={<IconPlayerPlay size={16} />}
            disabled={anyRunning}
            onClick={() => runCase(selectedCase)}
          >
            Run selected
          </Button>
          <Button
            color="teal"
            leftSection={<IconPlayerSkipForward size={16} />}
            disabled={anyRunning}
            onClick={runAllCases}
          >
            Run all 1-8
          </Button>
        </Stack>
      </AppShell.Navbar>

      <AppShell.Main>
        <Stack gap="md">
          <Paper shadow="xs" p="md" withBorder>
            <Group justify="space-between" align="flex-start">
              <Box>
                <Title order={4}>{activeCase.label}</Title>
                <Text size="sm" c="dimmed" mt={4}>
                  <Code>{activeCase.id}</Code>
                </Text>
                <Group gap="xs" mt="sm">
                  <Badge variant="light">{activeCase.difficulty}</Badge>
                  <Badge color="gray" variant="light">
                    {activeCase.ticketId}
                  </Badge>
                  <Badge color={dryRun ? "blue" : "green"} variant="light">
                    {dryRun ? "dry run" : "evaluate"}
                  </Badge>
                </Group>
              </Box>

              <Group>
                <Button
                  leftSection={<IconPlayerPlay size={16} />}
                  disabled={anyRunning}
                  onClick={() => runCase(selectedCase)}
                >
                  Run this case
                </Button>
                <Button
                  color="teal"
                  leftSection={<IconPlayerSkipForward size={16} />}
                  disabled={anyRunning}
                  onClick={runAllCases}
                >
                  Run all
                </Button>
              </Group>
            </Group>
          </Paper>

          <Paper shadow="xs" p="md" withBorder>
            <Title order={4} mb="md">
              Results
            </Title>

            <ScrollArea type="auto" offsetScrollbars>
              <Table striped highlightOnHover withTableBorder withColumnBorders>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Case</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Score</Table.Th>
                    <Table.Th>Passed</Table.Th>
                    <Table.Th>Evidence</Table.Th>
                    <Table.Th>Actions</Table.Th>
                    <Table.Th>Run</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {CASES.map((item) => {
                    const result = results[item.id];
                    const statusColor =
                      result.status === "success"
                        ? "green"
                        : result.status === "error"
                          ? "red"
                          : result.status === "running"
                            ? "blue"
                            : "gray";

                    return (
                      <Table.Tr key={item.id}>
                        <Table.Td>
                          <Stack gap={2}>
                            <Text size="sm" fw={600}>
                              {item.label}
                            </Text>
                            <Code>{item.id}</Code>
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          <Badge color={statusColor} variant="light">
                            {result.status}
                          </Badge>
                        </Table.Td>
                        <Table.Td>
                          {result.score === undefined ? "-" : result.score.toFixed(3)}
                        </Table.Td>
                        <Table.Td>
                          {result.passed === undefined ? "-" : result.passed ? "yes" : "no"}
                        </Table.Td>
                        <Table.Td>{result.evidenceCount ?? "-"}</Table.Td>
                        <Table.Td>{result.actionsDone ?? "-"}</Table.Td>
                        <Table.Td>
                          <Button
                            size="xs"
                            variant="light"
                            disabled={anyRunning}
                            onClick={() => {
                              setSelectedCase(item.id);
                              void runCase(item.id);
                            }}
                          >
                            Run
                          </Button>
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Paper>

          <Paper shadow="xs" p="md" withBorder>
            <Title order={4} mb="sm">
              Selected case output
            </Title>

            {selectedResult.status === "idle" && (
              <Text c="dimmed" size="sm">
                No run yet.
              </Text>
            )}

            {selectedResult.status === "running" && (
              <Text c="dimmed" size="sm">
                Running agent...
              </Text>
            )}

            {selectedResult.status === "error" && (
              <Text c="red" size="sm">
                {selectedResult.error}
              </Text>
            )}

            {selectedResult.status === "success" && (
              <Stack gap="xs">
                <Text size="sm">
                  runId: <Code>{selectedResult.runId}</Code>
                </Text>
                {selectedResult.missingEvidence && (
                  <Text size="sm">
                    missing evidence: <Code>{selectedResult.missingEvidence}</Code>
                  </Text>
                )}
                {selectedResult.missingActions && (
                  <Text size="sm">
                    missing actions: <Code>{selectedResult.missingActions}</Code>
                  </Text>
                )}
                {selectedResult.answer && (
                  <Paper p="sm" withBorder bg="gray.0">
                    <Text size="sm">{selectedResult.answer}</Text>
                  </Paper>
                )}
              </Stack>
            )}
          </Paper>
        </Stack>
      </AppShell.Main>
    </AppShell>
  );
}
