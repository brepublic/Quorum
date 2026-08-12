export const AUTH_MODAL_TRIGGER = '.nav__auth-status'
export const SANDBOX = '/committees/-LQCVY1042m3UW3y6ojd'

export function purge() {
  cy.clearLocalStorage()
  cy.then(() => new Cypress.Promise(resolve => {
    const request = indexedDB.deleteDatabase('firebaseLocalStorageDb')
    request.onsuccess = resolve
    request.onerror = resolve
    request.onblocked = resolve
  }))
}

export function enterUsername() {
  cy.get('input[autocomplete=email]')
    .type('fake@email.com')
    .should('have.value', 'fake@email.com')
}

export function enterCurrentPassword() {
  cy.get('input[autocomplete=current-password]')
    .type('fakepassword')
    .should('have.value', 'fakepassword')
}

export function enterNewPassword() {
  cy.get('input[autocomplete=new-password]')
    .type('fakepassword')
    .should('have.value', 'fakepassword')
}

export function invokeModalAndLogin() {
  cy.get(`${AUTH_MODAL_TRIGGER}:visible, i.sidebar.icon:visible`, {timeout: 10000})
    .first()
    .then($control => {
      if ($control.is('i.sidebar.icon')) {
        cy.wrap($control).parent().click()
      }
    })
  cy.get(`${AUTH_MODAL_TRIGGER}:visible`, {timeout: 10000}).then($trigger => {
    if ($trigger.text().includes('Login')) {
      cy.wrap($trigger).click()
      enterUsername()
      enterCurrentPassword()
      cy.get('.modal').find('button').contains('Log in').click()
      cy.get('body').type('{esc}')
      cy.wait(2000)
    }
  })
}
