import { expect, test, type Desktop } from './fixtures'

async function open(desktop: Desktop) {
  await desktop.page.evaluate(() => window.tiny!.apps.launch('org.tiny.calculator'))
  const frame = desktop.win('Calculator').frameLocator('iframe')
  await expect(frame.locator('#expr')).toHaveText('0')
  await frame.locator('.display').click()
  return frame
}

test('keyboard arithmetic with precedence, parentheses, percent and errors', async ({ desktop }) => {
  const { page } = desktop
  const frame = await open(desktop)
  const expr = frame.locator('#expr')

  await page.keyboard.type('12+3*4')
  await expect(expr).toHaveText('12+3×4')
  await expect(frame.locator('#preview')).toHaveText('= 24')
  await page.keyboard.press('Enter')
  await expect(expr).toHaveText('24')

  // an operator continues with the result, a digit starts over
  await page.keyboard.type('/8')
  await page.keyboard.press('Enter')
  await expect(expr).toHaveText('3')
  await page.keyboard.type('7')
  await expect(expr).toHaveText('7')

  await page.keyboard.press('Escape')
  await page.keyboard.type('(1+2)*(3+4)^2')
  await page.keyboard.press('Enter')
  await expect(expr).toHaveText('147')

  await page.keyboard.press('Escape')
  await page.keyboard.type('0.1+0.2')
  await page.keyboard.press('Enter')
  await expect(expr).toHaveText('0.3')

  await page.keyboard.press('Escape')
  await page.keyboard.type('50%')
  await page.keyboard.press('Enter')
  await expect(expr).toHaveText('0.5')

  await page.keyboard.press('Escape')
  await page.keyboard.type('5/0')
  await page.keyboard.press('Enter')
  await expect(expr).toHaveText('Error')
  await expect(frame.locator('#preview')).toHaveText('Division by zero')
  await page.keyboard.press('Backspace')
  await expect(expr).toHaveText('5÷')

  await page.keyboard.press('Escape')
  await page.keyboard.type('2-')
  await page.keyboard.type('-3')
  await page.keyboard.type('+4')
  await expect(expr).toHaveText('2−3+4') // a second operator replaces the first
})

test('the buttons work, with a history tape', async ({ desktop }) => {
  const frame = await open(desktop)
  const press = (name: string) => frame.getByRole('button', { name, exact: true }).click()
  await press('9')
  await press('multiply')
  await press('9')
  await press('equals')
  await expect(frame.locator('#expr')).toHaveText('81')
  await press('History')
  await expect(frame.locator('#items')).toContainText('9×9')
  await frame.locator('#items div').first().click()
  await expect(frame.locator('#history')).toBeHidden()
  await press('all clear')
  await expect(frame.locator('#expr')).toHaveText('0')
})

test('scientific mode: functions, degrees and radians, constants, factorial', async ({ desktop }) => {
  const { page } = desktop
  const frame = await open(desktop)
  await frame.getByRole('button', { name: 'Scientific' }).click()
  await expect(frame.getByRole('button', { name: 'sin', exact: true })).toBeVisible()
  const expr = frame.locator('#expr')
  const calc = async (s: string) => {
    await page.keyboard.press('Escape')
    await page.keyboard.type(s)
    await page.keyboard.press('Enter')
  }
  await frame.locator('.display').click()
  await calc('sqrt(144)+2^10')
  await expect(expr).toHaveText('1036')
  await calc('5!')
  await expect(expr).toHaveText('120')
  await calc('2pi')
  await expect(expr).toHaveText('6.28318530718')
  await calc('sin(30)')
  await expect(expr).toHaveText('0.5')
  await frame.getByRole('button', { name: 'Angle unit' }).click()
  await calc('cos(0)')
  await expect(expr).toHaveText('1')
  await calc('ln(e)')
  await expect(expr).toHaveText('1')
  await calc('-2^2')
  await expect(expr).toHaveText('-4')

  await frame.getByRole('button', { name: 'sin', exact: true }).click()
  await page.keyboard.type('90')
  await expect(frame.locator('#preview')).toHaveText('= 0.893996663601') // radians now
})

test('Cmd+C copies the result to the system clipboard', async ({ desktop }) => {
  const { page } = desktop
  const frame = await open(desktop)
  await page.keyboard.type('6*7')
  await page.keyboard.press('Enter')
  await expect(frame.locator('#expr')).toHaveText('42')
  await page.keyboard.press('Meta+c')
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const k = window.tiny!.kernel
        const port = await k.lookup('tiny.clipboard')
        const r = (await k.request(port, { op: 'read', types: ['public.utf8-plain-text'] })).data as { result?: { items: Array<{ data: unknown }> } }
        return r.result?.items?.[0]?.data
      }),
    )
    .toBe('42')
})
