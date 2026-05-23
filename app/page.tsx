'use client';

import { useState } from 'react';
import {
  AppShell,
  Burger,
  Group,
  Title,
  Text,
  Button,
  Paper,
  ScrollArea,
  Badge,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconRobot, IconPlayerPlay } from '@tabler/icons-react';
import { AgentTrace } from '@/src/components/AgentTrace';

// ─── Список кейсов в сайдбаре ───────────────────────────────────────────────
const SIDEBAR_CASES = [
  { id: 'case_01_subscription_activation', label: 'case_01_subscription' },
  { id: 'case_02_fraud_alert',             label: 'case_02_fraud_alert'   },
  { id: 'case_09_locked',                  label: 'case_09_locked (Secret)' },
] as const;

type SidebarCaseId = (typeof SIDEBAR_CASES)[number]['id'];

// ─── Данные активного кейса для левой колонки ────────────────────────────────
const ACTIVE_CASE = {
  id:             'case_01_subscription_activation',
  difficulty:     'easy',
  ticketId:       'tic_7hx2kq',
  userId:         'usr_a7m2q9',
  customerMessage: 'Здравствуйте, я оплатил подписку и она мне не применилась, почему так?',
} as const;

export default function AgentDashboard() {
  const [opened, { toggle }] = useDisclosure();

  /**
   * Выделенный кейс в сайдбаре. Инициализируется как case_01, т.к. именно
   * он является текущим рабочим кейсом. Кнопка «Создать новый Run» всегда
   * переключает выделение обратно на него.
   */
  const [activeCase, setActiveCase] = useState<SidebarCaseId>(
    'case_01_subscription_activation',
  );

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 300, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      {/* ── Шапка ───────────────────────────────────────────────────────────── */}
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <IconRobot size={30} color="#228be6" />
            <Title order={3}>GigaAgent Terminal</Title>
          </Group>
          <Badge color="green" variant="light">Система готова</Badge>
        </Group>
      </AppShell.Header>

      {/* ── Сайдбар со списком кейсов ───────────────────────────────────────── */}
      <AppShell.Navbar p="md">
        <Text fw={700} mb="sm">Доступные кейсы</Text>

        <Group align="center" mb="sm" style={{ flexDirection: 'column', gap: 4 }}>
          {SIDEBAR_CASES.map((c) => (
            <Button
              key={c.id}
              variant={activeCase === c.id ? 'light' : 'subtle'}
              color={activeCase === c.id ? 'blue' : 'gray'}
              fullWidth
              justify="flex-start"
              onClick={() => setActiveCase(c.id)}
            >
              {c.label}
            </Button>
          ))}
        </Group>

        {/*
          При клике выделяет case_01_subscription_activation как активный кейс.
          Это показывает пользователю, что новый Run будет создан именно для него.
        */}
        <Button
          mt="auto"
          color="teal"
          leftSection={<IconPlayerPlay size={16} />}
          onClick={() => setActiveCase('case_01_subscription_activation')}
        >
          Создать новый Run
        </Button>
      </AppShell.Navbar>

      {/* ── Основная рабочая область ─────────────────────────────────────────── */}
      <AppShell.Main>
        <Group align="flex-start" grow>

          {/* Левая колонка: Вводные данные */}
          <Paper shadow="xs" p="md" withBorder>
            <Title order={4} mb="md">Вводные данные</Title>

            <Text fw={500} c="dimmed" size="sm">Кейс:</Text>
            <Text mb="sm" size="sm" ff="monospace">{ACTIVE_CASE.id}</Text>

            <Text fw={500} c="dimmed" size="sm">Сложность:</Text>
            <Badge color="green" variant="light" mb="sm">{ACTIVE_CASE.difficulty}</Badge>

            <Text fw={500} c="dimmed" size="sm" mt="xs">Тикет:</Text>
            <Text mb="sm" size="sm" ff="monospace">{ACTIVE_CASE.ticketId}</Text>

            <Text fw={500} c="dimmed" size="sm">Пользователь:</Text>
            <Text mb="sm" size="sm" ff="monospace">{ACTIVE_CASE.userId}</Text>

            <Text fw={500} c="dimmed" size="sm">Сообщение клиента:</Text>
            <Text size="sm" fs="italic">
              «{ACTIVE_CASE.customerMessage}»
            </Text>
          </Paper>

          {/* Правая колонка: Agent Trace */}
          <Paper shadow="xs" p="md" withBorder>
            <Title order={4} mb="md">Agent Trace</Title>
            <ScrollArea h={520} type="auto" offsetScrollbars>
              <AgentTrace />
            </ScrollArea>
          </Paper>

        </Group>
      </AppShell.Main>
    </AppShell>
  );
}
