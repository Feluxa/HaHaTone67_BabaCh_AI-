'use client';

import { AppShell, Burger, Group, Skeleton, Title, Text, Button, Paper, ScrollArea, Badge } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { IconRobot, IconPlayerPlay } from '@tabler/icons-react';

export default function AgentDashboard() {
  const [opened, { toggle }] = useDisclosure();

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 300, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="md"
    >
      {/* Шапка */}
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

      {/* Боковое меню со списком кейсов */}
      <AppShell.Navbar p="md">
        <Text fw={700} mb="sm">Доступные кейсы</Text>
        <Group align="center" mb="sm">
            <Button variant="light" fullWidth justify="flex-start">
              case_01_subscription
            </Button>
            <Button variant="subtle" color="gray" fullWidth justify="flex-start">
              case_02_fraud_alert
            </Button>
            <Button variant="subtle" color="gray" fullWidth justify="flex-start">
              case_09_locked (Secret)
            </Button>
        </Group>
        
        <Button 
          mt="auto" 
          color="teal" 
          leftSection={<IconPlayerPlay size={16} />}
        >
          Создать новый Run
        </Button>
      </AppShell.Navbar>

      {/* Главная рабочая область */}
      <AppShell.Main>
        <Group align="flex-start" grow>
          
          {/* Левая колонка: Вводные данные */}
          <Paper shadow="xs" p="md" withBorder>
            <Title order={4} mb="md">Вводные данные (Ticket)</Title>
            <Text fw={500} c="dimmed" size="sm">Пользователь:</Text>
            <Text mb="sm">user_id=402</Text>
            
            <Text fw={500} c="dimmed" size="sm">Сообщение:</Text>
            <Text fs="italic">«У меня дважды списали $10 за премиум-подписку, помогите!»</Text>
            
            <Skeleton height={8} mt="xl" radius="xl" />
            <Skeleton height={8} mt="md" radius="xl" />
            <Skeleton height={8} mt="md" width="70%" radius="xl" />
          </Paper>

          {/* Правая колонка: Терминал мыслей агента */}
          <Paper shadow="xs" p="md" bg="dark.7" c="gray.1" withBorder>
            <Title order={4} mb="md" c="white">ReAct Logs / Действия Агента</Title>
            <ScrollArea h={400} type="always" offsetScrollbars>
              <Text size="sm" ff="monospace" c="green.4">
                [SYSTEM] Запуск расследования. Run_ID: run_abc123
              </Text>
              <Text size="sm" ff="monospace" mt="xs">
                {'>'} GET /support/tickets/tic_7hx2kq/messages
              </Text>
              <Text size="sm" ff="monospace" mt="xs" c="yellow.4">
                [THOUGHT] Клиент жалуется на двойное списание. Нужно проверить транзакции.
              </Text>
              <Text size="sm" ff="monospace" mt="xs">
                {'>'} GET /transactions?user_id=402
              </Text>
              <Text size="sm" ff="monospace" mt="xs" c="blue.3">
                [ACTION] Найдено два списания. Выполняю refund_transaction(id=tx_993)
              </Text>
            </ScrollArea>
          </Paper>

        </Group>
      </AppShell.Main>
    </AppShell>
  );
}