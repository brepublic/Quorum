import { purge, SANDBOX, invokeModalAndLogin } from './utils'
import "cypress-real-events/support";

const SELECT_MEMBER = '.adder__dropdown--select-member'
const SELECT_RANK = '.adder__dropdown--select-rank'
const TOGGLE_VOTING = '.adder__checkbox--toggle-voting'
const ADD_MEMBER = '.adder__button--add-member'
const REMOVE_MEMBER = ".members__button--remove-member"

function clickAddMember() {
  cy.get(ADD_MEMBER).realClick()
  cy.get(ADD_MEMBER).should('be.disabled')
  cy.get(SELECT_MEMBER).should('have.class', 'error')
}

function removeExistingMembers() {
  cy.get('body').then($body => {
    if (!$body.find(REMOVE_MEMBER).length) {
      return
    }

    cy.get(REMOVE_MEMBER).first().click()
    removeExistingMembers()
  })
}

describe('Add members and checks that the thresholds are sensible', function () {
  before(function () {
    purge()
    cy.visit(SANDBOX)
  })

  it('logs in to our test account', () => {
    invokeModalAndLogin()
  })

  it('navs to the admin page', () => {
    cy.contains('a:visible', 'Setup').realClick()
    cy.url().should('include', '/setup')
    cy.wait(2000)
  })

  it('removes all pre-existing members', function () {
    removeExistingMembers()
  })

  it('adds Afghanistan', function () {
    clickAddMember()
    cy.get('table').should('contain', 'Afghanistan')
  })

  it('adds Bolivia', function () {
    cy.get(SELECT_MEMBER).children('input').realClick().type('Bolivia{enter}')
    cy.get(SELECT_RANK).children('input').realClick().type('Observer{enter}')

    clickAddMember()

    cy.get('table').should('contain', 'Bolivia')
  })

  it('adds China', function () {
    cy.get(SELECT_MEMBER).children('input').realClick().type('China{enter}')
    cy.get(SELECT_RANK).children('input').realClick().type('Veto{enter}')
    cy.get(TOGGLE_VOTING).children('input').check({ force: true })

    clickAddMember()

    cy.get('table').should('contain', 'China')
  })

  it('shows only the pre-roll-call committee summary', function () {
    cy.get('table').eq(1).contains('Total').siblings().should('contain', '3')
    cy.get('table').eq(1).contains('Have voting rights').siblings().should('contain', '2')
    cy.get('table').eq(1).contains('Quorum').siblings().should('contain', '1')
    cy.get('table').eq(1).should('not.contain', 'Procedural threshold')
  })

  it('moves into roll call and records every delegation', function () {
    cy.contains('a:visible', 'Roll call').click()
    cy.url().should('include', '/roll-call')
    cy.get('.roll-call-member.status-uncalled').should('have.length', 3)

    cy.contains('button', 'Present').click()
    cy.get('.roll-call-member.status-present').should('have.length', 1)
    cy.contains('button', 'Absent').click()
    cy.get('.roll-call-member.status-absent').should('have.length', 1)
    cy.contains('button', 'Present').click()

    cy.contains('Roll call complete').should('be.visible')
    cy.contains('button', 'Go to motions').should('be.visible')
    cy.get('.roll-call-summary').should('contain', 'Procedural threshold')
  })
})
