const { getStatus } = require('../page-watch')
const { assert } = require('chai')

describe('page-watch', function() {

 describe('getStatus', function() {
   it('works', function() {
     const edit = {page: 'Foo', url: 'https://en.wikipedia.org/w/index.php?diff=123&oldid=456'}
     const name = 'Bar'
     const template = "{{page}} edited by {{name}} {{&url}}"
     const result = getStatus(edit, name, template)
     assert.equal('Foo edited by Bar https://en.wikipedia.org/w/index.php?diff=123&oldid=456', result.text)
   })
 })

})