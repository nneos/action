import React from 'react'
import {graphql} from 'react-relay'
import {RouteComponentProps, withRouter} from 'react-router-dom'
import QueryRenderer from 'universal/components/QueryRenderer/QueryRenderer'
import withAtmosphere, {
  WithAtmosphereProps
} from 'universal/decorators/withAtmosphere/withAtmosphere'
import UnpaidTeamModal from 'universal/modules/teamDashboard/components/UnpaidTeamModal/UnpaidTeamModal'
import {cacheConfig} from 'universal/utils/constants'
import renderQuery from '../../../../utils/relay/renderQuery'

const query = graphql`
  query UnpaidTeamModalRootQuery($teamId: ID!) {
    viewer {
      ...UnpaidTeamModal_viewer
    }
  }
`

interface Props extends WithAtmosphereProps, RouteComponentProps<{}> {
  teamId: string
}

const UnpaidTeamModalRoot = (props: Props) => {
  const {atmosphere, teamId} = props
  return (
    <QueryRenderer
      cacheConfig={cacheConfig}
      environment={atmosphere}
      query={query}
      variables={{teamId}}
      render={renderQuery(UnpaidTeamModal)}
    />
  )
}

export default withAtmosphere(withRouter(UnpaidTeamModalRoot))
