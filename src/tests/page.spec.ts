import { test, expect } from '@playwright/test';

test('has title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Travel Planner/);
});

test('get Paris itinerary from agent', async ({ page }) => {
    await page.goto('/');
    
    const prompt = 'I want to visit Paris for a week in January travelling from London';
    await page.fill('input[placeholder="Where would you like to go?"]', `${prompt}`);
    await page.keyboard.press('Enter');

    // Wait for the spinner to appear and then disappear
    await expect(page.locator('.spinner__container')).toBeVisible();
    await expect(page.locator('.spinner__container')).toBeHidden({ timeout: 2400000 });

    // Check that a response message from the agent is displayed
    const agentMessages = page.locator('.itinerary__div');
    await expect(agentMessages).toHaveCount(3);
    await expect(agentMessages.nth(0)).toContainText(prompt);
    await expect(agentMessages.nth(2)).toContainText('Paris', { timeout: 2400000 });
});

test('get Berlin itinerary from agent', async ({ page }) => {
    await page.goto('/');

    const prompt = 'Recommend me a 5 day trip to Berlin in March flying from London';
    await page.fill('input[placeholder="Where would you like to go?"]', `${prompt}`);
    await page.keyboard.press('Enter');

    // Wait for the spinner to appear and then disappear
    await expect(page.locator('.spinner__container')).toBeVisible();
    await expect(page.locator('.spinner__container')).toBeHidden({ timeout: 2400000 });

    // Check that a response message from the agent is displayed
    const agentMessages = page.locator('.itinerary__div');
    await expect(agentMessages).toHaveCount(3);
    await expect(agentMessages.nth(0)).toContainText(prompt);
    await expect(agentMessages.nth(2)).toContainText('Berlin', { timeout: 2400000 });
});

test('get changing itinerary from agent', async ({ page }) => {
    await page.goto('/');

    // First question
    const prompt = 'Recommend me a 5 day trip to Berlin in January flying from London';
    await page.fill('input[placeholder="Where would you like to go?"]', `${prompt}`);
    await page.keyboard.press('Enter');

    // Wait for the spinner to appear and then disappear
    await expect(page.locator('.spinner__container')).toBeVisible();
    await expect(page.locator('.spinner__container')).toBeHidden({ timeout: 2400000 });

    // Check that a response message from the agent is displayed
    const agentMessages = page.locator('.itinerary__div');
    await expect(agentMessages).toHaveCount(3);
    await expect(agentMessages.nth(0)).toContainText(prompt);
    await expect(agentMessages.nth(2)).toContainText('Berlin', { timeout: 2400000 });

    // Second question
    const anotherPrompt = 'Ok, what about if I want to spend 2 days in Berlin and 3 days in Munich. Can you recommend an itinerary>';
    await page.fill('input[placeholder="Where would you like to go?"]', `${anotherPrompt}`);
    await page.keyboard.press('Enter');

    // Wait for the spinner to appear and then disappear
    await expect(page.locator('.spinner__container')).toBeVisible();
    await expect(page.locator('.spinner__container')).toBeHidden({ timeout: 2400000 });

    // Check that a response message from the agent is displayed
    const secondSetofAgentMessages = page.locator('.itinerary__div');
    await expect(secondSetofAgentMessages).toHaveCount(3);
    await expect(secondSetofAgentMessages.nth(0)).toContainText(prompt);
    await expect(secondSetofAgentMessages.nth(2)).toContainText('Berlin', { timeout: 2400000 });
    await expect(secondSetofAgentMessages.nth(2)).toContainText('Munich', { timeout: 2400000 });
});

test('stop agent generation', async ({ page }) => {
    await page.goto('/');

    const prompt = 'Recommend me a 5 day trip to Amsterdam in March flying from London';
    await page.fill('input[placeholder="Where would you like to go?"]', `${prompt}`);
    await page.keyboard.press('Enter');

    // Wait for the spinner to appear and then disappear
    await expect(page.locator('.spinner__container')).toBeVisible();
    page.locator('#stop__button').click();
    await expect(page.locator('.spinner__container')).toBeHidden({ timeout: 2400000 });

    // Check that a response message from the agent is displayed
    const agentMessages = page.locator('.itinerary__div');
    await expect(agentMessages).toHaveCount(1);
});