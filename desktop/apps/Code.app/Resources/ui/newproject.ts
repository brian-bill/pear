// The New Project dialog: a centred modal over the window, in two steps — pick a template, then name the project.
import { escapeHtml } from '@tiny/sdk'
import type { TemplateDef } from './templates'

export interface NewProjectChoice {
  template: TemplateDef
  name: string
}

/** The folder a project name becomes: no extension, so it opens as a plain folder. */
export const folderName = (name: string): string => name.replace(/\.app$/i, '').replace(/[^\w-]+/g, '') || 'App'

export function pickNewProject(templates: TemplateDef[], projectsDir: string, restoreFocus: () => void): Promise<NewProjectChoice | null> {
  return new Promise((resolve) => {
    let step = 0
    let template = templates[0]!
    let name = 'Demo'

    const backdrop = document.createElement('div')
    backdrop.className = 'modal-backdrop'
    const dialog = document.createElement('div')
    dialog.className = 'modal'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', 'New Project')
    backdrop.append(dialog)

    const finish = (result: NewProjectChoice | null): void => {
      backdrop.remove()
      restoreFocus()
      resolve(result)
    }

    const next = (): void => {
      if (step === 0) {
        step = 1
        draw()
      } else if (name.trim()) finish({ template, name: name.trim() })
    }

    const draw = (): void => {
      const steps = ['Template', 'Name']
      const header = `<div class="modal-steps" aria-label="Step ${step + 1} of 2">${steps
        .map((s, i) => `<span class="modal-step" data-state="${i === step ? 'current' : i < step ? 'done' : 'todo'}"><b>${i + 1}</b>${s}</span>`)
        .join('<span class="modal-sep"></span>')}</div>`
      const body =
        step === 0
          ? `<h2>Choose a template</h2><div class="modal-cards" role="radiogroup" aria-label="Template">${templates
              .map(
                (t) =>
                  `<button type="button" class="modal-card" role="radio" aria-checked="${t === template}" data-id="${escapeHtml(t.id)}"><strong>${escapeHtml(t.label)}</strong><span>${escapeHtml(t.detail)}</span></button>`,
              )
              .join('')}</div>`
          : `<h2>Name your ${escapeHtml(template.label)}</h2><input class="modal-input" type="text" spellcheck="false" autocomplete="off" aria-label="Project name" value="${escapeHtml(name)}" placeholder="MyApp"><div class="modal-hint"></div>`
      dialog.innerHTML = `${header}${body}<div class="modal-actions"><button type="button" data-act="cancel">Cancel</button><span class="grow"></span>${step ? '<button type="button" data-act="back">Back</button>' : ''}<button type="button" class="primary" data-act="next">${step ? 'Create' : 'Next'}</button></div>`

      dialog.querySelectorAll<HTMLButtonElement>('.modal-card').forEach((card) => {
        card.addEventListener('click', () => {
          template = templates.find((t) => t.id === card.dataset.id) ?? template
          draw()
          dialog.querySelector<HTMLElement>('.modal-card[aria-checked="true"]')?.focus()
        })
        card.addEventListener('dblclick', next)
      })
      dialog.querySelector('[data-act="cancel"]')!.addEventListener('click', () => finish(null))
      dialog.querySelector('[data-act="back"]')?.addEventListener('click', () => {
        step = 0
        draw()
      })
      const nextBtn = dialog.querySelector<HTMLButtonElement>('[data-act="next"]')!
      nextBtn.addEventListener('click', next)

      const input = dialog.querySelector<HTMLInputElement>('.modal-input')
      if (input) {
        const hint = dialog.querySelector<HTMLElement>('.modal-hint')!
        const update = (): void => {
          name = input.value
          hint.textContent = name.trim() ? `Creates ${projectsDir}/${folderName(name)}` : 'Enter a name'
          nextBtn.disabled = !name.trim()
        }
        input.addEventListener('input', update)
        update()
        input.focus()
        input.select()
      } else (dialog.querySelector<HTMLElement>('.modal-card[aria-checked="true"]') ?? nextBtn).focus()
    }

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) finish(null)
    })
    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && e.target.dataset.act !== 'next' && !e.target.classList.contains('modal-card'))) {
        e.preventDefault()
        next()
      } else if (step === 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        const i = templates.indexOf(template)
        const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
        template = templates[(i + d + templates.length) % templates.length]!
        draw()
      }
    })

    document.body.append(backdrop)
    draw()
  })
}
