import React from 'react'
import styled from 'react-emotion'
import {PALETTE} from 'universal/styles/paletteV2'

const color = PALETTE.LINK.BLUE

const Link = styled('a')({
  color,
  marginTop: '1rem',
  textAlign: 'center',
  ':hover,:focus,:active': {
    color,
    textDecoration: 'underline'
  }
})

const FooterCopy = styled('div')({
  color: PALETTE.TEXT.LIGHT,
  fontSize: '.6875rem',
  lineHeight: '1.5rem',
  marginTop: '1rem',
  textAlign: 'center'
})

const AuthPrivacyFooter = () => (
  <FooterCopy>
    {'By creating an account, you agree to our '}
    <Link
      href='https://www.parabol.co/privacy'
      rel='noopener noreferrer'
      target='_blank'
      title='Privacy Policy'
    >
      {'Privacy Policy'}
    </Link>
    .
  </FooterCopy>
)

export default AuthPrivacyFooter
