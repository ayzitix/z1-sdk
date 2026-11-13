// A second service-only module. Its `ctx.get` must not see the services of
// `service-extras`, even though the host knows both.
export const services = {
  getter(ctx) {
    return {
      lookup(name) {
        return { found: ctx.get(name) !== undefined }
      },
    }
  },
}
